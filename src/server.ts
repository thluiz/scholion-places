// server.ts — builds the pieces, starts them, and keeps them in step.
//
// Everything that decides something lives elsewhere; this file only wires. The
// request itself is handled in http/handler.ts.
//
// Two background jobs keep the service honest about a repository it does not
// exclusively own: a periodic pull, and an mtime sweep that re-reads whatever
// changed. Somebody editing a place.json in a text editor and pushing is a
// supported way to work, not an accident to be defended against.

import { loadConfig } from "./config";
import type { ApiContext } from "./http/api";
import { createHandler } from "./http/handler";
import { Logger } from "./logger";
import { WriteBudget } from "./security/budget";
import { LiveAcl, warnUnknown } from "./security/live-acl";
import { FfmpegEncoder, PhotoStore } from "./storage/photos";
import { PlaceIndex, syncIndex } from "./storage/search";
import { Vault, describe } from "./storage/vault";

const SERVICE = "scholion-places";
const VERSION = "1.0.0";

const config = loadConfig();

const vault = new Vault({
  root: config.vaultDir,
  section: config.vaultSection,
  authorName: config.gitAuthorName,
  authorEmail: config.gitAuthorEmail,
  autoPush: config.autoPush,
  pushDelayMs: config.pushDelayMs,
});

const index = new PlaceIndex(config.indexPath);

const photos = new PhotoStore({
  dir: config.stagingDir,
  maxBytes: config.photoMaxBytes,
  ttlHours: config.stagingTtlHours,
  encoder: new FfmpegEncoder(config.photoMaxPx, config.photoQuality, config.ffmpegPath),
});

const logger = new Logger(config.logDir, config.logRetentionDays);
const budget = new WriteBudget(config.maxWritesPerMin, config.maxWritesPerDay);
const acl = await LiveAcl.open(config.aclPath, SERVICE);
const context: ApiContext = { config, vault, index, photos };

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  // Photos arrive as whole files; the default body limit is smaller than a phone.
  maxRequestBodySize: config.photoMaxBytes + 1024 * 1024,
  fetch: createHandler({ service: SERVICE, version: VERSION, context, acl, budget, logger }),
});

// ── boot and timers ──────────────────────────────────────────────────────────

await warnUnknown(config.aclPath);
await logger.prune();
await photos.prune();

const initial = await vault.readAll();
index.rebuild(initial);

for (const stash of await vault.checkForStrandedWork()) {
  console.error(
    `[${SERVICE}] there is work stashed in the vault — somebody's edit is waiting: ${stash}\n` +
      `           recover it with: git -C ${config.vaultDir} stash pop`,
  );
}
console.log(
  `[${SERVICE}] listening on http://${config.host}:${server.port} — ${initial.length} places, ` +
    `${acl.loaded.principals().length} principals, vault ${config.vaultDir}`,
);

/**
 * Catch up with the world.
 *
 * Pulls first, because the interesting change usually came from somewhere else,
 * then re-reads whatever moved. Failures are logged and forgiven: the next tick
 * tries again, and a service that refuses to answer because a fetch failed is
 * worse than one holding a slightly stale index.
 */
async function catchUp(): Promise<void> {
  try {
    if (config.autoPush) await vault.sync();
    const changes = await syncIndex(index, () => vault.readAll());
    if (changes.added || changes.updated || changes.removed) {
      console.log(
        `[${SERVICE}] index: +${changes.added} ~${changes.updated} -${changes.removed}`,
      );
    }
  } catch (error) {
    console.error(`[${SERVICE}] catch-up failed: ${describe(error)}`);
  }
}

const syncTimer = setInterval(() => void catchUp(), config.syncIntervalMs);
const sweepTimer = setInterval(() => {
  void photos.prune();
  void logger.prune();
}, 3_600_000);

async function shutdown(signal: string): Promise<void> {
  console.log(`[${SERVICE}] ${signal} — draining`);
  clearInterval(syncTimer);
  clearInterval(sweepTimer);
  server.stop();
  await vault.shutdown();
  index.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
