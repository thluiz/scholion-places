// handler.ts — one request, from the header that says who is asking to the
// line in the audit log.
//
// Identity comes from the X-Api-Key header and from nowhere else. Never from a
// field in the body: a caller must not be able to say who it is in the same
// breath as what it wants. In deployment the header is stamped by the reverse
// proxy, so the client holds no credential at all and cannot promote itself by
// sending a different one — the proof of identity is the path the request
// arrived on.

import type { Logger } from "../logger";
import { MCP_TOOLS, callTool, handleMcpGet, handleMcpOptions, handleMcpPost } from "../mcp/mcp";
import { MUTATING, assertOperation, type Principal } from "../security/acl";
import type { WriteBudget } from "../security/budget";
import type { LiveAcl } from "../security/live-acl";
import { describe } from "../storage/vault";
import type { ApiContext, ApiResult } from "./api";
import { json, outcomeFor, readJsonBody, statusFor, toResponse } from "./plumbing";
import { matchRoute } from "./routes";

export interface HandlerDeps {
  service: string;
  version: string;
  context: ApiContext;
  acl: LiveAcl;
  budget: WriteBudget;
  logger: Logger;
}

export function createHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  const { service, version, context, acl, budget, logger } = deps;
  const { vault, index } = context;

  return async function fetch(request) {
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
        service,
        version,
        places: index.count(),
        sync,
      });
    }

    if (request.method === "OPTIONS" && path === "/mcp") return handleMcpOptions();

    let principal: Principal | null = null;
    let operation = "unknown";
    let audit: ApiResult["audit"] = {};

    try {
      principal = (await acl.current()).authenticate(request.headers.get("x-api-key"));

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
      if (status === 500) console.error(`[${service}] ${request.method} ${path}: ${message}`);

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
  };
}
