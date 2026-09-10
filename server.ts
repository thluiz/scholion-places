// server.ts — HTTP, identity, and the timers.
//
// Identity comes from the X-Api-Key header and from nowhere else. Never from a
// field in the body: a caller must not be able to say who it is in the same
// breath as what it wants. In deployment the header is stamped by the reverse
// proxy, so the client holds no credential at all and cannot promote itself by
// sending a different one — the proof of identity is the path the request
// arrived on.
//
// Two background jobs keep the service honest about a repository it does not
// exclusively own: a periodic pull, and an mtime sweep that re-reads whatever
// changed. Somebody editing a place.json in a text editor and pushing is a
// supported way to work, not an accident to be defended against.

import { stat } from "node:fs/promises";

import {
  Acl,
  AuthenticationError,
  AuthorizationError,
  MUTATING,
  assertOperation,
  unknownOperations,
  type Principal,
} from "./acl";
import { RateLimitError, WriteBudget } from "./budget";
import { loadConfig } from "./config";
import { Logger, type AuditOutcome } from "./logger";
import {
  InvalidArgumentError,
  MCP_TOOLS,
  callTool,
  handleMcpGet,
  handleMcpOptions,
  handleMcpPost,
} from "./mcp";
import { ValidationError } from "./model";
import { FfmpegEncoder, PhotoNotFoundError, PhotoStore } from "./photos";
import { MethodNotAllowedError, matchRoute, type ApiContext, type ApiResult } from "./routes";
import { PlaceIndex, syncIndex } from "./search";
import { ConflictError, NotFoundError, Vault, describe } from "./vault";

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
const context: ApiContext = { config, vault, index, photos };

// ── the ACL, re-read when it moves ───────────────────────────────────────────

let acl = await Acl.load(config.aclPath);
let aclMtimeMs = (await stat(config.aclPath)).mtimeMs;
let aclCheckedAt = 0;

async function warnUnknown(path: string): Promise<void> {
  const file = JSON.parse(await Bun.file(path).text());
  const unknown = unknownOperations(file);
  if (unknown.length) {
    console.warn(`[acl] these names match no operation and control nothing: ${unknown.join(", ")}`);
  }
}

/**
 * The current ACL, reloaded if the file changed.
 *
 * Throttled to one stat every few seconds, and deliberately forgiving: a
 * half-saved edit keeps the previous rules in force rather than locking
 * everybody out.
 */
async function currentAcl(): Promise<Acl> {
  const now = Date.now();
  if (now - aclCheckedAt < 5_000) return acl;
  aclCheckedAt = now;

  try {
    const { mtimeMs } = await stat(config.aclPath);
    if (mtimeMs !== aclMtimeMs) {
      acl = await Acl.load(config.aclPath);
      aclMtimeMs = mtimeMs;
      await warnUnknown(config.aclPath);
      console.log(`[${SERVICE}] acl reloaded — ${acl.principals().length} principals`);
    }
  } catch (error) {
    console.error(`[${SERVICE}] keeping previous ACL: ${describe(error)}`);
  }
  return acl;
}

// ── errors ───────────────────────────────────────────────────────────────────

function statusFor(error: unknown): number {
  if (
    error instanceof AuthenticationError ||
    error instanceof AuthorizationError ||
    error instanceof ValidationError ||
    error instanceof RateLimitError ||
    error instanceof NotFoundError ||
    error instanceof PhotoNotFoundError ||
    error instanceof ConflictError ||
    error instanceof InvalidArgumentError ||
    error instanceof MethodNotAllowedError
  ) {
    return error.status;
  }
  return 500;
}

function outcomeFor(status: number): AuditOutcome {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "denied";
  return status >= 400 ? "error" : "ok";
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

// ── the request ──────────────────────────────────────────────────────────────

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};

  const text = await request.text();
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError("the request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("the request body is not valid JSON");
  }
}

function toResponse(result: ApiResult): Response {
  const status = result.status ?? 200;
  if (status === 204 || result.body === undefined) {
    return new Response(null, { status, headers: result.headers });
  }
  if (typeof result.body === "string") {
    return new Response(result.body, { status, headers: result.headers });
  }
  return json(result.body, status, result.headers ?? {});
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  // Photos arrive as whole files; the default body limit is smaller than a phone.
  maxRequestBodySize: config.photoMaxBytes + 1024 * 1024,

  async fetch(request) {
    const started = Date.now();
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && path === "/health") {
      // A stash in the vault means somebody's uncommitted edit collided with the
      // remote and is waiting to be recovered. Never normal, so `ok` goes false:
      // the one place a person is likely to look should say something is wrong.
      const sync = vault.state;
      return json({
        ok: !sync.strandedStash,
        service: SERVICE,
        version: VERSION,
        places: index.count(),
        sync,
      });
    }

    if (request.method === "OPTIONS" && path === "/mcp") return handleMcpOptions();

    let principal: Principal | null = null;
    let operation = "unknown";
    let audit: ApiResult["audit"] = {};

    try {
      principal = (await currentAcl()).authenticate(request.headers.get("x-api-key"));

      // MCP is a second way in to the same routes, so it gets the same audit
      // trail and the same write budget. What it must not get is a second copy
      // of the rules — see mcp.ts.
      if (path === "/mcp") {
        if (request.method === "GET") return handleMcpGet();
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

        const caller = principal;
        return await handleMcpPost(request, {
          principal: caller,
          ctx: context,
          async execute(name, args) {
            const startedTool = Date.now();
            const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
            if (tool && MUTATING.has(tool.operation)) budget.consume(caller.name);

            try {
              const result = await callTool(context, caller, name, args);
              void logger.write({
                principal: caller.name,
                operation: tool?.operation ?? name,
                outcome: "ok",
                method: "MCP",
                path: `tools/call/${name}`,
                slug: typeof args.slug === "string" ? args.slug : undefined,
                durationMs: Date.now() - startedTool,
              });
              return result;
            } catch (error) {
              void logger.write({
                principal: caller.name,
                operation: tool?.operation ?? name,
                outcome: outcomeFor(statusFor(error)),
                method: "MCP",
                path: `tools/call/${name}`,
                slug: typeof args.slug === "string" ? args.slug : undefined,
                message: describe(error),
                durationMs: Date.now() - startedTool,
              });
              throw error;
            }
          },
        });
      }

      // What this caller may do, which is not the same as what the API can do.
      // A denied operation is absent from this list, so a client built from it
      // never learns the operation exists.
      if (request.method === "GET" && path === "/me") {
        operation = "me";
        return json({
          principal: principal.name,
          role: principal.role,
          operations: [...principal.operations].sort(),
          budget: budget.remaining(principal.name),
        });
      }

      const matched = matchRoute(request.method, path);
      if (!matched) return json({ error: "Not found" }, 404);

      const { route, params } = matched;
      operation = route.operation ?? "unknown";
      if (route.operation) assertOperation(principal, route.operation);
      if (route.operation && MUTATING.has(route.operation)) budget.consume(principal.name);

      const result = await route.handle(context, {
        principal,
        params,
        query: url.searchParams,
        headers: request.headers,
        body: await readJsonBody(request),
        raw: request,
      });

      audit = result.audit ?? {};
      const response = toResponse(result);
      void logger.write({
        principal: principal.name,
        operation,
        outcome: outcomeFor(response.status),
        method: request.method,
        path,
        status: response.status,
        durationMs: Date.now() - started,
        ...audit,
      });
      return response;
    } catch (error) {
      const status = statusFor(error);
      const message = describe(error);
      if (status === 500) console.error(`[${SERVICE}] ${request.method} ${path}: ${message}`);

      void logger.write({
        principal: principal?.name ?? null,
        operation,
        outcome: outcomeFor(status),
        method: request.method,
        path,
        status,
        message,
        durationMs: Date.now() - started,
        ...audit,
      });
      return json({ error: message }, status);
    }
  },
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
    `${acl.principals().length} principals, vault ${config.vaultDir}`,
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
