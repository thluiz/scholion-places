// mcp.ts — the same API, spoken as MCP.
//
// Every tool here is a *view* of a REST route, not a second implementation of
// it. A tool declares the request it stands for, and the call goes through the
// same `matchRoute` and the same handler as an HTTP request would — so
// validation, authorisation, the audit trail and the git write are shared by
// construction. There is no path by which the two can drift apart.
//
// The surface is deliberately smaller than the API. A model working from a
// phone message needs to find a place, record what was there, and correct it;
// it does not need to rename slugs or re-render the site. What is missing here
// is still reachable over REST by whoever holds a key for it.
//
// Tools are filtered by what the caller may actually do, so an operation the
// principal lacks is never listed. Telling a model not to use a tool it can see
// is a suggestion; not showing it is a boundary.

import { assertOperation, type Operation, type Principal } from "./acl";
import { matchRoute, type ApiContext } from "./routes";

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_NAME = "scholion-places";
export const SERVER_VERSION = "1.0.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, X-Api-Key",
};

type Args = Record<string, unknown>;

interface McpTool {
  name: string;
  description: string;
  operation: Operation;
  inputSchema: Record<string, unknown>;
  /** The REST request this tool stands for. */
  request(args: Args): { method: string; path: string; body?: Args };
}

// ── argument helpers ─────────────────────────────────────────────────────────
//
// Only enough to build a URL. Everything else is the route's job, and doing it
// twice is how the two surfaces would start disagreeing.

function query(pairs: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}

function slugOf(args: Args): string {
  const slug = args.slug;
  if (typeof slug !== "string" || !slug) throw new Error("slug is required");
  return encodeURIComponent(slug);
}

// ── schema fragments ─────────────────────────────────────────────────────────

const SPECIES_ARG = {
  type: "array",
  items: { type: "string" },
  description:
    "The flowers seen, by common name. Several are normal. Accents and capitals do not matter — " +
    "'Papoila-das-searas' and 'papoila das searas' are recorded as the same thing.",
};

const PHOTOS_ARG = {
  type: "array",
  items: { type: "string" },
  description:
    "Ids of photos already uploaded, in the form the upload gave you (foto:7f3a2c). " +
    "Only pass ids you were actually given: if none appeared, no photo arrived, and saying so is better " +
    "than recording a sighting that claims a picture it does not have.",
};

export const MCP_TOOLS: McpTool[] = [
  {
    name: "places_search",
    description:
      "Search the collection of places. Combine freely: month=4 answers 'what flowers here in April' " +
      "across every year on record, and near+radius_km narrows it to where you are.",
    operation: "places.search",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Free text: a name, a note, a species, part of an address." },
        kind: { type: "string", enum: ["flores", "restaurante"], description: "Only places of this kind." },
        tag: { type: "string", description: "Only places carrying this tag." },
        species: { type: "string", description: "Only places where this flower has been recorded." },
        month: { type: "integer", description: "1-12. Places with a visit in this month, any year." },
        near: { type: "string", description: "Coordinates as 'lat,lon' to search around." },
        radius_km: { type: "number", description: "How far around 'near' to look. Defaults to 5." },
        since: { type: "string", description: "Only places visited on or after this date (YYYY-MM-DD)." },
        until: { type: "string", description: "Only places visited on or before this date (YYYY-MM-DD)." },
        limit: { type: "integer", description: "How many to return. Defaults to 25." },
      },
    },
    request: (args) => ({ method: "GET", path: `/places${query(args)}` }),
  },

  {
    name: "places_nearby",
    description:
      "The places closest to a point, nearest first, with the distance in metres. " +
      "Use this before recording anything: a place seen again is an entry on the one that exists, " +
      "not a new record.",
    operation: "places.search",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude." },
        lon: { type: "number", description: "Longitude." },
        radius_km: { type: "number", description: "How far to look. Defaults to 1." },
      },
      required: ["lat", "lon"],
    },
    request: (args) => ({
      method: "GET",
      path: `/places${query({ near: `${args.lat},${args.lon}`, radius_km: args.radius_km ?? 1 })}`,
    }),
  },

  {
    name: "place_get",
    description: "Everything recorded about one place, including every visit and its photos.",
    operation: "places.get",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "The place's slug." } },
      required: ["slug"],
    },
    request: (args) => ({ method: "GET", path: `/places/${slugOf(args)}` }),
  },

  {
    name: "place_create",
    description:
      "Record a place that is not in the collection yet. Refuses if there is already one within about " +
      "eighty metres and tells you which — that is almost always the same field seen again, and it should " +
      "get an entry instead. Pass force only when it is genuinely somewhere else.",
    operation: "place.create",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What to call the place." },
        lat: { type: "number", description: "Latitude." },
        lon: { type: "number", description: "Longitude." },
        kind: {
          type: "array",
          items: { type: "string", enum: ["flores", "restaurante"] },
          description: "What sort of place it is. It can be both.",
        },
        tags: { type: "array", items: { type: "string" }, description: "Region, trail, whatever groups it." },
        address: { type: "string", description: "How to describe getting there." },
        summary: { type: "string", description: "One line about the place." },
        body: { type: "string", description: "Longer prose: where to park, what to notice." },
        force: { type: "boolean", description: "Create it even though something else is close by." },
      },
      required: ["title", "lat", "lon"],
    },
    request: (args) => ({
      method: "POST",
      path: "/places",
      body: {
        title: args.title,
        coords: { lat: args.lat, lon: args.lon },
        kind: args.kind,
        tags: args.tags,
        address: args.address,
        summary: args.summary,
        body: args.body,
        force: args.force,
      },
    }),
  },

  {
    name: "place_add_entry",
    description:
      "Record a visit to a place that already exists: what was in flower, or what was eaten. " +
      "Defaults to today. A place accumulates these over the years, which is the point of the collection.",
    operation: "entry.create",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Which place." },
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
        type: {
          type: "string",
          enum: ["sighting", "visit"],
          description: "A sighting of flowers, or a visit to a restaurant. Defaults to sighting.",
        },
        species: SPECIES_ARG,
        note: { type: "string", description: "What was worth remembering." },
        dish: { type: "string", description: "For a restaurant: what was eaten." },
        rating: { type: "integer", description: "For a restaurant: 1 to 5." },
        photos: PHOTOS_ARG,
      },
      required: ["slug"],
    },
    request: (args) => ({
      method: "POST",
      path: `/places/${slugOf(args)}/entries`,
      body: {
        date: args.date,
        type: args.type,
        species: args.species,
        note: args.note,
        dish: args.dish,
        rating: args.rating,
        photos: args.photos,
      },
    }),
  },

  {
    name: "place_update_entry",
    description:
      "Correct a visit that was recorded wrongly — the date, the flowers, the note. " +
      "Only the fields you pass change. Get the entry's id from place_get.",
    operation: "entry.update",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Which place." },
        entry_id: { type: "string", description: "The id of the visit, as shown by place_get." },
        date: { type: "string", description: "The corrected date, YYYY-MM-DD." },
        species: SPECIES_ARG,
        note: { type: "string", description: "The corrected note." },
        dish: { type: "string", description: "The corrected dish." },
        rating: { type: "integer", description: "The corrected rating, 1 to 5." },
      },
      required: ["slug", "entry_id"],
    },
    request: (args) => ({
      method: "PATCH",
      path: `/places/${slugOf(args)}/entries/${encodeURIComponent(String(args.entry_id ?? ""))}`,
      body: {
        date: args.date,
        species: args.species,
        note: args.note,
        dish: args.dish,
        rating: args.rating,
      },
    }),
  },

  {
    name: "places_list_species",
    description: "Every flower recorded so far, with how many places each has been seen at.",
    operation: "places.labels",
    inputSchema: { type: "object", properties: {} },
    request: () => ({ method: "GET", path: "/species" }),
  },
];

const BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

/** The tools this principal may actually use. The rest are not mentioned. */
export function toolsFor(principal: Principal): McpTool[] {
  return MCP_TOOLS.filter((tool) => principal.operations.has(tool.operation));
}

/**
 * Run a tool by dispatching it as the REST request it stands for.
 *
 * Note what is *not* here: no validation, no permission logic, no writing. All
 * of that is the route's, and reaching it through `matchRoute` is what keeps
 * this file from becoming a second implementation with its own bugs.
 */
export async function callTool(
  ctx: ApiContext,
  principal: Principal,
  name: string,
  args: Args,
): Promise<unknown> {
  const tool = BY_NAME.get(name);
  if (!tool) throw new InvalidArgumentError(`Unknown tool: ${name}`);
  assertOperation(principal, tool.operation);

  const { method, path, body } = tool.request(args ?? {});
  const url = new URL(`http://mcp${path}`);
  const matched = matchRoute(method, url.pathname.replace(/\/+$/, "") || "/");
  if (!matched) throw new Error(`no route behind tool ${name}`);

  const result = await matched.route.handle(ctx, {
    principal,
    params: matched.params,
    query: url.searchParams,
    headers: new Headers(),
    body: body ?? {},
    raw: new Request(url, { method }),
  });

  return result.body;
}

export class InvalidArgumentError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

// ── JSON-RPC framing ─────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpSession {
  principal: Principal;
  ctx: ApiContext;
  /** Wraps the call with the audit trail and the write budget. */
  execute(name: string, args: Args): Promise<unknown>;
}

function ok(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatch(request: JsonRpcRequest, session: McpSession): Promise<unknown | null> {
  switch (request.method) {
    case "initialize":
      return ok(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
      return null; // A notification has no reply.

    case "ping":
      return ok(request.id, {});

    case "tools/list":
      return ok(request.id, {
        tools: toolsFor(session.principal).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });

    case "tools/call": {
      const name = request.params?.name;
      if (typeof name !== "string") return fail(request.id, -32602, "params.name must be a string");
      const args = (request.params?.arguments ?? {}) as Args;

      try {
        const result = await session.execute(name, args);
        return ok(request.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (error) {
        // A malformed call is a protocol error; a refusal, a rate limit or an
        // upstream failure is a normal result the model should read and act on.
        // Returning those as JSON-RPC errors would hide the reason from it.
        if (error instanceof InvalidArgumentError) {
          return fail(request.id, -32602, error.message);
        }
        return ok(request.id, {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        });
      }
    }

    default:
      return fail(request.id, -32601, `Unknown method: ${request.method}`);
  }
}

export function handleMcpOptions(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** The SSE channel a Streamable HTTP client opens and keeps open. */
export function handleMcpGet(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": connected\n\n"));
    },
  });
  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

export async function handleMcpPost(request: Request, session: McpSession): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(fail(null, -32700, "Parse error"), { status: 400, headers: CORS });
  }

  const batch = Array.isArray(payload) ? payload : [payload];
  const replies = (await Promise.all(batch.map((item) => dispatch(item as JsonRpcRequest, session)))).filter(
    (reply) => reply !== null,
  );

  if (!replies.length) return new Response(null, { status: 202, headers: CORS });
  return Response.json(Array.isArray(payload) ? replies : replies[0], { headers: CORS });
}
