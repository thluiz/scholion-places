// vault.ts — the records on disk, and the git repository they live in.
//
// Modelled directly on vox-ingest-api, which has been doing this for another
// content repository for months. The order of operations is copied from it
// because that order is the one that survives a repository changing underneath:
//
//   1. validate before touching disk — fail without leaving half a commit behind
//   2. write the files
//   3. git add with an explicit pathspec, never `add -A`
//   4. commit, tolerating "nothing to commit" as a normal outcome
//   5. pull --rebase
//   6. push
//
// Steps 1–4 are synchronous: the caller gets its answer once the commit exists,
// because from that moment the record is safe. Steps 5–6 run in the background,
// because they are durability, not correctness — and because a slow network
// must not make saving a flower feel slow.
//
// Everything that touches the repository goes through one queue. Two git
// operations in one working tree is not a theoretical problem: a rebase moving
// files under a write is exactly how a working tree ends up wedged.

import { $ } from "bun";
import { mkdir, readdir, readFile, rm, stat, unlink, rename as renamePath } from "node:fs/promises";
import { join } from "node:path";

import { parsePlace, serialisePlace, assertSlug, type Place } from "./model";
import { renderPlace } from "./render";

export const RECORD_FILE = "place.json";
export const RENDERED_FILE = "index.md";

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface StoredPlace {
  place: Place;
  etag: string;
  mtimeMs: number;
}

export interface WriteOptions {
  message: string;
  /** Files to copy into the bundle before committing, as { name -> source path }. */
  attach?: { name: string; from: string }[];
  /** Bundle-relative filenames to remove in the same commit. */
  remove?: string[];
}

export interface VaultOptions {
  /** The clone of the content repository. */
  root: string;
  /** Where the records live inside it. */
  section?: string;
  authorName?: string;
  authorEmail?: string;
  /** Off in tests, and anywhere without a remote. */
  autoPush?: boolean;
  /** How long to wait for more writes before pushing. */
  pushDelayMs?: number;
}

/**
 * A promise chain that runs one task at a time.
 *
 * Deliberately not a library: the only requirement is that a failed task does
 * not poison the ones behind it, which is the single line below.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves once everything queued so far has settled. Used by tests and shutdown. */
  async drain(): Promise<void> {
    await this.tail;
  }
}

export function etagOf(serialised: string): string {
  return new Bun.CryptoHasher("sha256").update(serialised).digest("hex").slice(0, 32);
}

export class Vault {
  readonly root: string;
  readonly section: string;
  readonly queue = new SerialQueue();

  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly autoPush: boolean;
  private readonly pushDelayMs: number;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: VaultOptions) {
    this.root = options.root;
    this.section = options.section ?? "content/places";
    this.authorName = options.authorName ?? "scholion-places";
    this.authorEmail = options.authorEmail ?? "scholion-places@localhost";
    this.autoPush = options.autoPush ?? false;
    this.pushDelayMs = options.pushDelayMs ?? 2_000;
  }

  sectionDir(): string {
    return join(this.root, this.section);
  }

  bundleDir(slug: string): string {
    return join(this.sectionDir(), assertSlug(slug));
  }

  /**
   * The bundle as git sees it: repository-relative, forward slashes.
   *
   * Not `path.join`. On Windows that yields backslashes, and git treats a
   * backslash in a pathspec as an escape — the add silently matches nothing.
   */
  private pathspec(slug: string): string {
    return `${this.section}/${slug}`;
  }

  // ── reading ────────────────────────────────────────────────────────────────

  /**
   * Every slug that has a record.
   *
   * A directory without a place.json is not a place: the JSON is the record,
   * and a stray folder is something a person put there.
   */
  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.sectionDir());
    } catch {
      return [];
    }

    const slugs: string[] = [];
    for (const name of names) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      if (await Bun.file(join(this.sectionDir(), name, RECORD_FILE)).exists()) slugs.push(name);
    }
    return slugs.sort();
  }

  async read(slug: string): Promise<StoredPlace> {
    const path = join(this.bundleDir(slug), RECORD_FILE);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new NotFoundError(`no place with slug ${slug}`);
    }

    const place = parsePlace(JSON.parse(raw));
    const { mtimeMs } = await stat(path);
    return { place, etag: etagOf(raw), mtimeMs };
  }

  async exists(slug: string): Promise<boolean> {
    return Bun.file(join(this.bundleDir(slug), RECORD_FILE)).exists();
  }

  /** Read everything. Used to rebuild the index, which is cheap at this scale. */
  async readAll(): Promise<StoredPlace[]> {
    const stored: StoredPlace[] = [];
    for (const slug of await this.list()) {
      try {
        stored.push(await this.read(slug));
      } catch (error) {
        // One unreadable record must not blind the search to all the others.
        console.error(`[vault] skipping ${slug}: ${describe(error)}`);
      }
    }
    return stored;
  }

  /**
   * Refuse the write if the record moved since the caller read it.
   *
   * There are two writers — an agent and a person with a text editor — so a
   * lost update is not hypothetical. Callers that pass no expectation get the
   * old behaviour, which is what a fresh create wants.
   */
  async assertUnchanged(slug: string, expectedEtag: string | undefined): Promise<void> {
    if (!expectedEtag) return;
    const current = await this.read(slug);
    if (current.etag !== expectedEtag) {
      throw new ConflictError(`${slug} changed since you read it`);
    }
  }

  // ── writing ────────────────────────────────────────────────────────────────

  async write(place: Place, options: WriteOptions): Promise<StoredPlace> {
    // Validate before the queue, so a bad request fails fast and never delays
    // a good one.
    const validated = parsePlace(place);
    const serialised = serialisePlace(validated);
    const rendered = renderPlace(validated);

    return this.queue.run(async () => {
      const dir = this.bundleDir(validated.slug);
      await mkdir(dir, { recursive: true });

      for (const attachment of options.attach ?? []) {
        await renameOrCopy(attachment.from, join(dir, attachment.name));
      }
      for (const name of options.remove ?? []) {
        await unlink(join(dir, name)).catch(() => undefined);
      }

      await Bun.write(join(dir, RECORD_FILE), serialised);
      await Bun.write(join(dir, RENDERED_FILE), rendered);

      await this.commit([this.pathspec(validated.slug)], options.message);

      const { mtimeMs } = await stat(join(dir, RECORD_FILE));
      return { place: validated, etag: etagOf(serialised), mtimeMs };
    });
  }

  /** Write only the rendered file. Used by a mass re-render, which must not touch records. */
  async rerender(slug: string): Promise<boolean> {
    const { place } = await this.read(slug);
    const rendered = renderPlace(place);
    const path = join(this.bundleDir(slug), RENDERED_FILE);

    const existing = await Bun.file(path)
      .text()
      .catch(() => null);
    if (existing === rendered) return false;

    return this.queue.run(async () => {
      await Bun.write(path, rendered);
      return true;
    });
  }

  async remove(slug: string, message: string): Promise<void> {
    const dir = this.bundleDir(slug);
    if (!(await this.exists(slug))) throw new NotFoundError(`no place with slug ${slug}`);

    await this.queue.run(async () => {
      await rm(dir, { recursive: true, force: true });
      await this.commit([this.pathspec(slug)], message);
    });
  }

  async rename(from: string, to: string, message: string): Promise<void> {
    assertSlug(from);
    assertSlug(to);
    if (!(await this.exists(from))) throw new NotFoundError(`no place with slug ${from}`);
    if (await this.exists(to)) throw new ConflictError(`a place already uses the slug ${to}`);

    const { place } = await this.read(from);
    const renamed: Place = { ...place, slug: to };

    await this.queue.run(async () => {
      await renamePath(this.bundleDir(from), this.bundleDir(to));
      await Bun.write(join(this.bundleDir(to), RECORD_FILE), serialisePlace(renamed));
      await Bun.write(join(this.bundleDir(to), RENDERED_FILE), renderPlace(renamed));
      await this.commit([this.pathspec(from), this.pathspec(to)], message);
    });
  }

  /**
   * Commit whatever changed across the whole section.
   *
   * Only a mass re-render needs this: hundreds of index.md files rewritten by
   * one template change belong in one commit, not hundreds. Still an explicit
   * pathspec — the section — never `add -A`, so a stray file elsewhere in the
   * content repository is not swept in by accident.
   */
  async commitSection(message: string): Promise<boolean> {
    return this.queue.run(() => this.commit([this.section], message));
  }

  /** Stage and commit an explicit set of paths, then schedule the push. */
  async commit(pathspecs: string[], message: string): Promise<boolean> {
    await $`git -C ${this.root} add -- ${pathspecs}`.quiet();

    const result = await $`git -C ${this.root} -c user.name=${this.authorName} -c user.email=${this.authorEmail} commit -m ${message}`
      .quiet()
      .nothrow();

    if (result.exitCode !== 0) {
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      // A no-op write is normal — re-rendering an unchanged place, or setting a
      // field to the value it already had. Anything else is a real failure.
      if (/nothing to commit|no changes added/i.test(output)) return false;
      throw new Error(`git commit failed: ${output.trim()}`);
    }

    this.schedulePush();
    return true;
  }

  // ── the remote ─────────────────────────────────────────────────────────────

  private schedulePush(): void {
    if (!this.autoPush || this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.sync().catch(() => undefined);
    }, this.pushDelayMs);
    // Do not hold the process open just to push.
    this.pushTimer.unref?.();
  }

  /**
   * Reconcile with the remote and push, in the queue.
   *
   * This is the only safe way in. Two `git fetch` in one repository race on
   * `FETCH_HEAD` and fail with errors that read like repository corruption —
   * "cannot rebase onto multiple branches" — so the raw operation below is
   * never called directly.
   */
  async sync(): Promise<void> {
    return this.queue.run(() => this.syncUnqueued());
  }

  /** The raw pull-and-push. Call {@link sync} instead. */
  private async syncUnqueued(): Promise<void> {
    // --autostash, because the working tree is not ours alone. Editing a record
    // by hand is a supported way to work, and a plain `pull --rebase` refuses to
    // run while those edits are uncommitted — which would silently strand every
    // commit this service makes for as long as the edit sits there. Autostash
    // sets the edit aside, rebases, and puts it back; nothing is discarded.
    const pull = await $`git -C ${this.root} pull --rebase --autostash --quiet`.quiet().nothrow();
    if (pull.exitCode !== 0) {
      console.error(`[vault] pull --rebase failed: ${pull.stderr.toString().trim()}`);
      return; // Leave the commits local; the next write tries again.
    }

    const push = await $`git -C ${this.root} push --quiet`.quiet().nothrow();
    if (push.exitCode !== 0) {
      console.error(`[vault] push failed: ${push.stderr.toString().trim()}`);
    }
  }

  async shutdown(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    await this.queue.drain();
  }
}

/**
 * Move a file, falling back to a copy across filesystems.
 *
 * The staging area and the vault can sit on different mounts, and rename(2)
 * refuses to cross that line.
 */
async function renameOrCopy(from: string, to: string): Promise<void> {
  try {
    await renamePath(from, to);
  } catch {
    await Bun.write(to, Bun.file(from));
    await unlink(from).catch(() => undefined);
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
