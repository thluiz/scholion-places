// logger.ts — the audit trail.
//
// What matters here is what is absent: no API keys, no photo bytes, no prose.
// Identifiers, the operation, and the outcome. Enough to answer "who changed
// that, and when", and not enough to be worth stealing.
//
// Refusals are recorded as loudly as successes. A run of 403s is how a leaked
// key or an agent stuck in a loop announces itself.

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export type AuditOutcome = "ok" | "denied" | "error" | "rate_limited";

export interface AuditEntry {
  principal: string | null;
  operation: string;
  outcome: AuditOutcome;
  method?: string;
  path?: string;
  slug?: string;
  entryId?: string;
  photoId?: string;
  status?: number;
  message?: string;
  durationMs?: number;
}

export class Logger {
  private readonly ready: Promise<unknown>;

  constructor(
    private readonly dir: string,
    private readonly retentionDays: number,
  ) {
    this.ready = mkdir(dir, { recursive: true, mode: 0o750 });
  }

  async write(entry: AuditEntry): Promise<void> {
    const now = new Date();
    const line = `${JSON.stringify({ ts: now.toISOString(), ...entry })}\n`;
    try {
      await this.ready;
      await appendFile(join(this.dir, `${now.toISOString().slice(0, 10)}.ndjson`), line, {
        encoding: "utf8",
        mode: 0o640,
      });
    } catch (error) {
      // Losing an audit line must never lose the request it describes.
      console.error(`[logger] failed to append audit entry: ${error}`);
    }
  }

  async prune(): Promise<void> {
    try {
      await this.ready;
      const cutoff = Date.now() - this.retentionDays * 86_400_000;
      for (const name of await readdir(this.dir)) {
        const match = /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
        if (!match) continue;
        if (new Date(`${match[1]}T00:00:00Z`).getTime() < cutoff) {
          await unlink(join(this.dir, name)).catch(() => undefined);
        }
      }
    } catch (error) {
      console.error(`[logger] failed to prune: ${error}`);
    }
  }
}
