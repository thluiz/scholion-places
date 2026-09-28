// live-acl.ts — the ACL, re-read when the file moves.
//
// Adding a consumer is an edit to acl.json, and that edit should not need a
// restart. The file is watched by mtime, not by an fs watcher: an editor that
// saves through a rename would lose the watch, and a stat every few seconds
// costs nothing.

import { stat } from "node:fs/promises";

import { describe } from "../storage/vault";
import { Acl, unknownOperations } from "./acl";

/** Say so when the file names operations that do not exist, and so control nothing. */
export async function warnUnknown(path: string): Promise<void> {
  const file = JSON.parse(await Bun.file(path).text());
  const unknown = unknownOperations(file);
  if (unknown.length) {
    console.warn(`[acl] these names match no operation and control nothing: ${unknown.join(", ")}`);
  }
}

export class LiveAcl {
  private checkedAt = 0;

  private constructor(
    private readonly path: string,
    private readonly label: string,
    private acl: Acl,
    private mtimeMs: number,
  ) {}

  static async open(path: string, label: string): Promise<LiveAcl> {
    const acl = await Acl.load(path);
    const { mtimeMs } = await stat(path);
    return new LiveAcl(path, label, acl, mtimeMs);
  }

  /** The rules as last loaded, without looking at the file. */
  get loaded(): Acl {
    return this.acl;
  }

  /**
   * The current ACL, reloaded if the file changed.
   *
   * Throttled to one stat every few seconds, and deliberately forgiving: a
   * half-saved edit keeps the previous rules in force rather than locking
   * everybody out.
   */
  async current(): Promise<Acl> {
    const now = Date.now();
    if (now - this.checkedAt < 5_000) return this.acl;
    this.checkedAt = now;

    try {
      const { mtimeMs } = await stat(this.path);
      if (mtimeMs !== this.mtimeMs) {
        this.acl = await Acl.load(this.path);
        this.mtimeMs = mtimeMs;
        await warnUnknown(this.path);
        console.log(`[${this.label}] acl reloaded — ${this.acl.principals().length} principals`);
      }
    } catch (error) {
      console.error(`[${this.label}] keeping previous ACL: ${describe(error)}`);
    }
    return this.acl;
  }
}
