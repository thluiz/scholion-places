// vault.test.ts — against a real git repository in a temporary directory.
//
// Faking git here would test nothing worth testing. The interesting cases are
// the ones git decides: an empty commit, a pathspec that matches nothing, a
// rename that has to move a directory and rewrite what is inside it.

import { $ } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePlace, serialisePlace, type Place } from "./model";
import { ConflictError, NotFoundError, RECORD_FILE, RENDERED_FILE, SerialQueue, Vault } from "./vault";

let root: string;
let vault: Vault;

function place(overrides: Partial<Place> = {}): Place {
  return parsePlace({
    title: "Fonte da Pipa",
    coords: { lat: 40.32611, lon: -7.61389 },
    created: "2026-04-12T10:12:00+01:00",
    updated: "2026-04-12T10:12:00+01:00",
    entries: [
      {
        id: "e7f3a2",
        date: "2026-04-12",
        type: "sighting",
        by: "thiago",
        species: ["papoila-das-searas"],
        photos: [],
      },
    ],
    ...overrides,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "places-vault-"));
  await $`git -C ${root} init -q -b main`.quiet();
  await mkdir(join(root, "content", "places"), { recursive: true });
  await writeFile(join(root, "README.md"), "content repo\n");
  await $`git -C ${root} add -A`.quiet();
  await $`git -C ${root} -c user.name=t -c user.email=t@t commit -q -m init`.quiet();

  vault = new Vault({ root, autoPush: false });
});

afterEach(async () => {
  await vault.shutdown();
  await rm(root, { recursive: true, force: true });
});

async function log(): Promise<string[]> {
  const out = await $`git -C ${root} log --format=%s`.quiet().text();
  return out.trim().split("\n");
}

describe("writing a record", () => {
  test("produces both files and one commit", async () => {
    const stored = await vault.write(place(), { message: "places: novo local Fonte da Pipa" });

    expect(stored.place.slug).toBe("fonte-da-pipa");
    const dir = vault.bundleDir("fonte-da-pipa");
    expect(await Bun.file(join(dir, RECORD_FILE)).exists()).toBe(true);
    expect(await Bun.file(join(dir, RENDERED_FILE)).exists()).toBe(true);

    expect(await log()).toEqual(["places: novo local Fonte da Pipa", "init"]);
  });

  test("the working tree is clean afterwards — nothing left unstaged", async () => {
    await vault.write(place(), { message: "places: novo local" });
    const status = await $`git -C ${root} status --porcelain`.quiet().text();
    expect(status.trim()).toBe("");
  });

  test("rewriting with identical content makes no commit", async () => {
    await vault.write(place(), { message: "places: primeiro" });
    await vault.write(place(), { message: "places: segundo" });
    expect(await log()).toEqual(["places: primeiro", "init"]);
  });

  test("the record on disk is what parsePlace round-trips", async () => {
    const written = await vault.write(place(), { message: "places: novo local" });
    const raw = await readFile(join(vault.bundleDir("fonte-da-pipa"), RECORD_FILE), "utf8");
    expect(raw).toBe(serialisePlace(written.place));
  });
});

describe("reading", () => {
  test("a place that was never written", async () => {
    await expect(vault.read("nao-existe")).rejects.toThrow(NotFoundError);
  });

  test("list ignores a directory with no record in it", async () => {
    await vault.write(place(), { message: "places: novo local" });
    await mkdir(join(vault.sectionDir(), "pasta-solta"), { recursive: true });
    await writeFile(join(vault.sectionDir(), "pasta-solta", "index.md"), "solto\n");

    expect(await vault.list()).toEqual(["fonte-da-pipa"]);
  });

  test("readAll survives one corrupt record", async () => {
    await vault.write(place(), { message: "places: bom" });
    await mkdir(join(vault.sectionDir(), "estragado"), { recursive: true });
    await writeFile(join(vault.sectionDir(), "estragado", RECORD_FILE), "{ nao e json");

    const all = await vault.readAll();
    expect(all.map((entry) => entry.place.slug)).toEqual(["fonte-da-pipa"]);
  });
});

describe("etag guards the lost update", () => {
  test("a stale etag is refused and the file is untouched", async () => {
    const first = await vault.write(place(), { message: "places: novo" });

    // Somebody else edits in between.
    await vault.write(place({ title: "Fonte da Pipa", summary: "editado por outro" }), {
      message: "places: edicao concorrente",
    });

    await expect(vault.assertUnchanged("fonte-da-pipa", first.etag)).rejects.toThrow(ConflictError);

    const current = await vault.read("fonte-da-pipa");
    expect(current.place.summary).toBe("editado por outro");
  });

  test("the current etag passes", async () => {
    const stored = await vault.write(place(), { message: "places: novo" });
    await expect(vault.assertUnchanged("fonte-da-pipa", stored.etag)).resolves.toBeUndefined();
  });

  test("no expectation means no check — which is what a create wants", async () => {
    await expect(vault.assertUnchanged("nem-existe", undefined)).resolves.toBeUndefined();
  });
});

describe("re-render touches only the rendered file", () => {
  test("a template change rewrites index.md and leaves place.json alone", async () => {
    await vault.write(place(), { message: "places: novo" });
    const recordPath = join(vault.bundleDir("fonte-da-pipa"), RECORD_FILE);
    const before = await readFile(recordPath, "utf8");

    // Simulate a stale rendering, as a layout change would leave behind.
    await writeFile(join(vault.bundleDir("fonte-da-pipa"), RENDERED_FILE), "desatualizado\n");

    expect(await vault.rerender("fonte-da-pipa")).toBe(true);
    expect(await readFile(recordPath, "utf8")).toBe(before);
    expect(await readFile(join(vault.bundleDir("fonte-da-pipa"), RENDERED_FILE), "utf8")).toContain(
      "title: \"Fonte da Pipa\"",
    );
  });

  test("re-rendering an up-to-date place reports no change", async () => {
    await vault.write(place(), { message: "places: novo" });
    expect(await vault.rerender("fonte-da-pipa")).toBe(false);
  });
});

describe("removing and renaming", () => {
  test("remove deletes the bundle and commits it", async () => {
    await vault.write(place(), { message: "places: novo" });
    await vault.remove("fonte-da-pipa", "places: remove Fonte da Pipa");

    expect(await vault.exists("fonte-da-pipa")).toBe(false);
    expect(await log()).toEqual(["places: remove Fonte da Pipa", "places: novo", "init"]);
    expect((await $`git -C ${root} status --porcelain`.quiet().text()).trim()).toBe("");
  });

  test("removing something that is not there", async () => {
    await expect(vault.remove("nao-existe", "x")).rejects.toThrow(NotFoundError);
  });

  test("rename moves the bundle and rewrites the slug inside it", async () => {
    await vault.write(place(), { message: "places: novo" });
    await vault.rename("fonte-da-pipa", "fonte-da-pipa-norte", "places: renomeia");

    expect(await vault.exists("fonte-da-pipa")).toBe(false);
    const moved = await vault.read("fonte-da-pipa-norte");
    expect(moved.place.slug).toBe("fonte-da-pipa-norte");
    expect(moved.place.title).toBe("Fonte da Pipa");
    expect((await $`git -C ${root} status --porcelain`.quiet().text()).trim()).toBe("");
  });

  test("rename onto an occupied slug is refused", async () => {
    await vault.write(place(), { message: "places: a" });
    await vault.write(place({ title: "Outro Sitio" }), { message: "places: b" });
    await expect(vault.rename("fonte-da-pipa", "outro-sitio", "x")).rejects.toThrow(ConflictError);
  });
});

describe("attachments", () => {
  test("a staged file is moved into the bundle and committed with the record", async () => {
    const staged = join(root, "staged.jpg");
    await writeFile(staged, "not really a jpeg");

    const withPhoto = place({
      entries: [
        {
          id: "e7f3a2",
          date: "2026-04-12",
          type: "sighting",
          by: "thiago",
          species: ["papoila-das-searas"],
          photos: [{ id: "p2c81f", file: "2026-04-12-papoila.jpg" }],
        },
      ],
    } as Partial<Place>);

    await vault.write(withPhoto, {
      message: "places: foto",
      attach: [{ name: "2026-04-12-papoila.jpg", from: staged }],
    });

    const photoPath = join(vault.bundleDir("fonte-da-pipa"), "2026-04-12-papoila.jpg");
    expect(await Bun.file(photoPath).exists()).toBe(true);
    expect(await Bun.file(staged).exists()).toBe(false);

    const tracked = await $`git -C ${root} ls-files content/places/fonte-da-pipa`.quiet().text();
    expect(tracked).toContain("2026-04-12-papoila.jpg");
  });

  test("a detached photo is deleted in the same commit", async () => {
    const staged = join(root, "staged.jpg");
    await writeFile(staged, "bytes");
    const withPhoto = place({
      entries: [
        {
          id: "e7f3a2",
          date: "2026-04-12",
          type: "sighting",
          by: "thiago",
          photos: [{ id: "p2c81f", file: "2026-04-12-papoila.jpg" }],
        },
      ],
    } as Partial<Place>);
    await vault.write(withPhoto, {
      message: "places: foto",
      attach: [{ name: "2026-04-12-papoila.jpg", from: staged }],
    });

    await vault.write(place(), { message: "places: remove foto", remove: ["2026-04-12-papoila.jpg"] });

    const tracked = await $`git -C ${root} ls-files content/places/fonte-da-pipa`.quiet().text();
    expect(tracked).not.toContain("2026-04-12-papoila.jpg");
  });
});

describe("syncing with a remote", () => {
  // Each of these spawns a dozen git processes against three repositories on
  // disk. On a slow filesystem that outruns the default five seconds, and the
  // failure is ugly: the test times out, afterEach deletes the temporary
  // directory, and the git operation still in flight fails against a path that
  // no longer exists.
  const LENTO = 30_000;

  let remote: string;
  let clone: string;
  let pushing: Vault;

  beforeEach(async () => {
    remote = await mkdtemp(join(tmpdir(), "places-remote-"));
    await $`git -C ${remote} init -q --bare -b main`.quiet();
    await $`git -C ${root} remote add origin ${remote}`.quiet();
    await $`git -C ${root} push -q -u origin main`.quiet();

    clone = await mkdtemp(join(tmpdir(), "places-clone-"));
    await $`git clone -q ${remote} ${clone}`.quiet();
    pushing = new Vault({ root, autoPush: true, pushDelayMs: 60_000 });
  });

  afterEach(async () => {
    await pushing.shutdown();
    await rm(remote, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  });

  test("a commit reaches the remote", async () => {
    await pushing.write(place(), { message: "places: novo local" });
    await pushing.sync();

    await $`git -C ${clone} pull -q`.quiet();
    expect(await Bun.file(join(clone, "content", "places", "fonte-da-pipa", RECORD_FILE)).exists()).toBe(true);
  }, LENTO);

  test("a hand edit does not strand the push, and survives it", async () => {
    await pushing.write(place(), { message: "places: novo local" });

    // Somebody opens the record in an editor and does not commit. A plain
    // `pull --rebase` refuses to run in this state, and every commit the service
    // makes would sit unsent for as long as the edit is there.
    const recordPath = join(pushing.bundleDir("fonte-da-pipa"), RECORD_FILE);
    const edited = (await readFile(recordPath, "utf8")).replace(
      '"title": "Fonte da Pipa"',
      '"title": "Fonte da Pipa (editado à mão)"',
    );
    await writeFile(recordPath, edited);

    await pushing.sync();

    // The commit went out...
    await $`git -C ${clone} pull -q`.quiet();
    expect(await Bun.file(join(clone, "content", "places", "fonte-da-pipa", RECORD_FILE)).exists()).toBe(true);

    // ...and the uncommitted edit is still sitting in the working tree.
    expect(await readFile(recordPath, "utf8")).toContain("editado à mão");
    expect((await $`git -C ${root} stash list`.quiet().text()).trim()).toBe("");
  }, LENTO);

  test("a dirty tree is not rebased at all when the remote has not moved", async () => {
    await pushing.write(place(), { message: "places: novo local" });

    const recordPath = join(pushing.bundleDir("fonte-da-pipa"), RECORD_FILE);
    await writeFile(recordPath, (await readFile(recordPath, "utf8")).replace("Fonte da Pipa", "Editado"));

    await pushing.sync();

    // No rebase happened, so the edit was never even set aside.
    expect((await $`git -C ${root} stash list`.quiet().text()).trim()).toBe("");
    expect(await readFile(recordPath, "utf8")).toContain("Editado");
    expect(pushing.state.strandedStash).toBeUndefined();
  }, LENTO);

  test("an edit that collides with the remote is kept in the stash and reported", async () => {
    await pushing.write(place(), { message: "places: novo local" });
    await pushing.sync();

    // Somebody else edits the same record and pushes.
    await $`git -C ${clone} pull -q`.quiet();
    const theirs = join(clone, "content", "places", "fonte-da-pipa", RECORD_FILE);
    await writeFile(theirs, (await readFile(theirs, "utf8")).replace("Fonte da Pipa", "Vindo do remoto"));
    await $`git -C ${clone} add -A`.quiet();
    await $`git -C ${clone} -c user.name=o -c user.email=o@o commit -q -m "outro edita"`.quiet();
    await $`git -C ${clone} push -q`.quiet();

    // Meanwhile the service records something else entirely, so there is a
    // local commit to push and therefore a rebase to do...
    await pushing.write(place({ title: "Outro Sitio" }), { message: "places: outro sitio" });

    // ...and here somebody has the first record open in an editor, uncommitted.
    const ours = join(pushing.bundleDir("fonte-da-pipa"), RECORD_FILE);
    await writeFile(ours, (await readFile(ours, "utf8")).replace("Fonte da Pipa", "Editado à mão"));

    await pushing.sync();

    // git exits 0 on this path, so the only way to know is to look afterwards.
    expect(pushing.state.strandedStash).toContain("stash");
    expect(pushing.state.strandedHint).toContain("stash pop");
    // The push still went out, and a success must not erase the warning.
    expect(pushing.state.lastError).toBeUndefined();
    expect(pushing.state.lastSyncAt).toBeGreaterThan(0);

    // The working tree is left valid — no conflict markers inside a record,
    // which would make it unparseable and drop the place out of the index.
    const onDisk = await readFile(ours, "utf8");
    expect(onDisk).not.toContain("<<<<<<<");
    expect(() => JSON.parse(onDisk)).not.toThrow();

    // And the edit is recoverable, in full.
    const stashed = await $`git -C ${root} stash show -p stash@{0}`.quiet().text();
    expect(stashed).toContain("Editado à mão");
  }, LENTO);

  test("a commit made elsewhere is rebased under ours, not lost", async () => {
    await writeFile(join(clone, "OUTRO.md"), "vindo de outro sitio\n");
    await $`git -C ${clone} add -A`.quiet();
    await $`git -C ${clone} -c user.name=o -c user.email=o@o commit -q -m "outro escritor"`.quiet();
    await $`git -C ${clone} push -q`.quiet();

    await pushing.write(place(), { message: "places: novo local" });
    await pushing.sync();

    const log = await $`git -C ${root} log --format=%s`.quiet().text();
    expect(log).toContain("outro escritor");
    expect(log).toContain("places: novo local");
    expect(await Bun.file(join(root, "OUTRO.md")).exists()).toBe(true);
  }, LENTO);
});

describe("SerialQueue", () => {
  test("runs tasks one at a time, in order", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    const slow = (n: number, ms: number) =>
      queue.run(async () => {
        await Bun.sleep(ms);
        order.push(n);
      });

    await Promise.all([slow(1, 20), slow(2, 5), slow(3, 1)]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("a failed task does not poison the ones behind it", async () => {
    const queue = new SerialQueue();
    const failed = queue.run(async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await expect(queue.run(async () => "fine")).resolves.toBe("fine");
  });
});
