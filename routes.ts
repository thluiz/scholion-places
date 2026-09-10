// routes.ts — the API surface, one handler per resource.
//
// Three things are worth knowing before reading:
//
//   1. Every mutation reads the record, changes it in memory, and writes the
//      whole thing back. There is no partial write and no in-place edit of a
//      file, so a failure halfway leaves the previous version intact.
//
//   2. Entries and photos are addressed by opaque id, never by date or
//      position. That is what makes "fix the visit I got wrong" expressible at
//      all, and it is the correction the first draft of this service could not
//      make.
//
//   3. `If-Match` is honoured on every write to an existing record. There are
//      two writers — a client and a person with a text editor — so a lost
//      update is a matter of when, not whether.

import type { Operation, Principal } from "./acl";
import type { Config } from "./config";
import { describeImage } from "./describe";
import { NEIGHBOUR_RADIUS_M, distanceMeters, slugify } from "./geo";
import {
  ValidationError,
  assertCoords,
  assertDate,
  assertEntryType,
  assertId,
  assertKinds,
  assertSlug,
  mintEntryId,
  mintPhotoId,
  normaliseLabels,
  optionalRating,
  optionalString,
  requiredString,
  speciesOf,
  type Entry,
  type Place,
} from "./model";
import { photoFilename, type PhotoStore } from "./photos";
import type { PlaceIndex, SearchQuery } from "./search";
import { localDate, localTimestamp } from "./time";
import { ConflictError, NotFoundError, type StoredPlace, type Vault } from "./vault";

export interface ApiContext {
  config: Config;
  vault: Vault;
  index: PlaceIndex;
  photos: PhotoStore;
}

export interface ApiRequest {
  principal: Principal;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Headers;
  /** Parsed JSON body, or undefined. Multipart requests keep the raw Request. */
  body: Record<string, unknown>;
  raw: Request;
}

export interface ApiResult {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Filled in by the router for the audit log. */
  audit?: { slug?: string; entryId?: string; photoId?: string };
}

export interface Route {
  method: string;
  pattern: RegExp;
  operation: Operation | null;
  handle(ctx: ApiContext, request: ApiRequest): Promise<ApiResult>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function ifMatch(headers: Headers): string | undefined {
  const value = headers.get("if-match");
  if (!value || value === "*") return undefined;
  return value.replace(/^W\//, "").replace(/^"|"$/g, "");
}

function shapePlace(stored: StoredPlace) {
  const { place } = stored;
  return {
    slug: place.slug,
    title: place.title,
    kind: place.kind,
    tags: place.tags,
    species: speciesOf(place),
    summary: place.summary,
    address: place.address,
    coords: place.coords,
    body: place.body,
    created: place.created,
    updated: place.updated,
    etag: stored.etag,
    entries: place.entries,
  };
}

function findEntry(place: Place, id: string): Entry {
  const entry = place.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new NotFoundError(`no entry ${id} at ${place.slug}`);
  return entry;
}

/** Every photo filename already in use at a place, so a new one does not collide. */
function takenFilenames(place: Place): string[] {
  return place.entries.flatMap((entry) => entry.photos.map((photo) => photo.file));
}

/**
 * Read, change, write, reindex.
 *
 * The single path through which every mutation passes. Anything that skips it
 * risks a record on disk the index has never seen.
 */
async function mutate(
  ctx: ApiContext,
  slug: string,
  request: ApiRequest,
  message: string,
  change: (place: Place) => Promise<{ place: Place; attach?: { name: string; from: string }[]; remove?: string[] }>,
): Promise<StoredPlace> {
  const current = await ctx.vault.read(slug);
  await ctx.vault.assertUnchanged(slug, ifMatch(request.headers));

  const { place, attach, remove } = await change(structuredClone(current.place));
  place.updated = localTimestamp();

  const stored = await ctx.vault.write(place, { message, attach, remove });
  ctx.index.upsert(stored);
  return stored;
}

function entryFields(input: Record<string, unknown>, principal: Principal, existing?: Entry) {
  const type = input.type !== undefined ? assertEntryType(input.type) : (existing?.type ?? "sighting");
  return {
    date: input.date !== undefined ? assertDate(input.date) : (existing?.date ?? localDate()),
    type,
    by: existing?.by ?? principal.name,
    species: input.species !== undefined ? normaliseLabels(input.species, "species") : (existing?.species ?? []),
    dish: input.dish !== undefined ? optionalString(input.dish, "dish", 200) : existing?.dish,
    rating: input.rating !== undefined ? optionalRating(input.rating) : existing?.rating,
    note: input.note !== undefined ? optionalString(input.note, "note", 2000) : existing?.note,
  };
}

/**
 * Claim staged photos and work out what each one is called in the bundle.
 *
 * Naming happens here, not in the photo store, because the name is derived from
 * the visit — its date and what was seen — and the store knows nothing about
 * visits.
 */
async function claimPhotos(
  ctx: ApiContext,
  place: Place,
  entry: Entry,
  ids: unknown,
): Promise<{ attach: { name: string; from: string }[] }> {
  if (ids === undefined || ids === null) return { attach: [] };
  if (!Array.isArray(ids)) throw new ValidationError("photos must be a list of staged photo ids");
  if (ids.length > 20) throw new ValidationError("attach at most twenty photos at a time");

  const taken = takenFilenames(place);
  const attach: { name: string; from: string }[] = [];

  for (const id of ids) {
    if (typeof id !== "string") throw new ValidationError("photos must be a list of staged photo ids");
    const source = await ctx.photos.claim(id.replace(/^foto:/, ""));
    const name = photoFilename(entry.date, entry.species ?? [], taken);

    taken.push(name);
    attach.push({ name, from: source });
    entry.photos.push({ id: mintPhotoId(entry), file: name });
  }

  return { attach };
}

// ── places ───────────────────────────────────────────────────────────────────

function parseSearch(query: URLSearchParams): SearchQuery {
  const near = query.get("near");
  let coords;
  if (near) {
    const [lat, lon] = near.split(",").map(Number);
    coords = assertCoords({ lat, lon }, 6);
  }

  const month = query.get("month");
  if (month !== null && !/^(1[0-2]|[1-9])$/.test(month)) {
    throw new ValidationError("month must be a number from 1 to 12");
  }

  return {
    q: query.get("q") ?? undefined,
    kind: query.get("kind") ?? undefined,
    tag: query.get("tag") ?? undefined,
    species: query.get("species") ?? undefined,
    month: month === null ? undefined : Number(month),
    near: coords,
    radiusKm: query.get("radius_km") ? Number(query.get("radius_km")) : undefined,
    since: query.get("since") ? assertDate(query.get("since"), "since") : undefined,
    until: query.get("until") ? assertDate(query.get("until"), "until") : undefined,
    limit: query.get("limit") ? Number(query.get("limit")) : undefined,
    offset: query.get("offset") ? Number(query.get("offset")) : undefined,
  };
}

/**
 * A slug nobody is using yet.
 *
 * Two places may honestly share a name — there is more than one Fonte da Pipa —
 * so a collision is numbered rather than refused. The near-duplicate check
 * below is what catches the other case, the one where it is really the same
 * field recorded twice.
 */
async function freeSlug(ctx: ApiContext, title: string): Promise<string> {
  const base = slugify(title);
  if (!base) throw new ValidationError("title does not produce a usable slug");
  if (!(await ctx.vault.exists(base))) return base;

  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!(await ctx.vault.exists(candidate))) return candidate;
  }
  throw new ConflictError(`too many places already named ${base}`);
}

export const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/places$/,
    operation: "places.search",
    async handle(ctx, request) {
      return { body: ctx.index.search(parseSearch(request.query)) };
    },
  },

  {
    method: "POST",
    pattern: /^\/places$/,
    operation: "place.create",
    async handle(ctx, request) {
      const title = requiredString(request.body.title, "title");
      const coords = assertCoords(request.body.coords, ctx.config.coordPrecision);

      // A field visited twice is one place, not two. Without this the whole
      // point of the collection — a place seen across seasons — breaks into
      // unrelated records that no query joins back together.
      if (request.body.force !== true) {
        const radius = ctx.config.neighbourRadiusM || NEIGHBOUR_RADIUS_M;
        const near = ctx.index
          .nearby(coords, radius / 1000)
          .results.filter((hit) => distanceMeters(coords, hit.coords) <= radius);

        if (near.length) {
          throw new ConflictError(
            `there is already a place ${near[0].distanceM} m away: ${near[0].slug} (${near[0].title}). ` +
              `Add an entry to it, or pass force: true if this really is a different place.`,
          );
        }
      }

      const now = localTimestamp();
      const place: Place = {
        slug: await freeSlug(ctx, title),
        title,
        kind: assertKinds(request.body.kind),
        tags: normaliseLabels(request.body.tags, "tags"),
        summary: optionalString(request.body.summary, "summary", 400),
        address: optionalString(request.body.address, "address", 300),
        coords,
        body: optionalString(request.body.body, "body", 20_000),
        created: now,
        updated: now,
        entries: [],
      };

      const stored = await ctx.vault.write(place, { message: `places: novo local ${place.title}` });
      ctx.index.upsert(stored);

      return {
        status: 201,
        body: shapePlace(stored),
        headers: { ETag: `"${stored.etag}"`, Location: `/places/${stored.place.slug}` },
        audit: { slug: stored.place.slug },
      };
    },
  },

  {
    method: "GET",
    pattern: /^\/places\/(?<slug>[^/]+)$/,
    operation: "places.get",
    async handle(ctx, request) {
      const stored = await ctx.vault.read(assertSlug(request.params.slug));
      return {
        body: shapePlace(stored),
        headers: { ETag: `"${stored.etag}"` },
        audit: { slug: stored.place.slug },
      };
    },
  },

  {
    method: "PATCH",
    pattern: /^\/places\/(?<slug>[^/]+)$/,
    operation: "place.update",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      const input = request.body;

      const stored = await mutate(ctx, slug, request, `places: actualiza ${slug}`, async (place) => {
        if (input.title !== undefined) place.title = requiredString(input.title, "title");
        if (input.kind !== undefined) place.kind = assertKinds(input.kind);
        if (input.tags !== undefined) place.tags = normaliseLabels(input.tags, "tags");
        if (input.summary !== undefined) place.summary = optionalString(input.summary, "summary", 400);
        if (input.address !== undefined) place.address = optionalString(input.address, "address", 300);
        if (input.body !== undefined) place.body = optionalString(input.body, "body", 20_000);
        if (input.coords !== undefined) place.coords = assertCoords(input.coords, ctx.config.coordPrecision);
        return { place };
      });

      return { body: shapePlace(stored), headers: { ETag: `"${stored.etag}"` }, audit: { slug } };
    },
  },

  {
    method: "DELETE",
    pattern: /^\/places\/(?<slug>[^/]+)$/,
    operation: "place.delete",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      await ctx.vault.assertUnchanged(slug, ifMatch(request.headers));
      await ctx.vault.remove(slug, `places: remove ${slug}`);
      ctx.index.forget(slug);
      return { status: 204, audit: { slug } };
    },
  },

  {
    method: "POST",
    pattern: /^\/places\/(?<slug>[^/]+)\/rename$/,
    operation: "place.rename",
    async handle(ctx, request) {
      const from = assertSlug(request.params.slug);
      const to = assertSlug(requiredString(request.body.slug, "slug"), "slug");

      await ctx.vault.rename(from, to, `places: renomeia ${from} para ${to}`);
      ctx.index.forget(from);
      ctx.index.upsert(await ctx.vault.read(to));

      return { body: shapePlace(await ctx.vault.read(to)), audit: { slug: to } };
    },
  },

  // ── entries ────────────────────────────────────────────────────────────────

  {
    method: "GET",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries$/,
    operation: "places.get",
    async handle(ctx, request) {
      const { place } = await ctx.vault.read(assertSlug(request.params.slug));
      return { body: { entries: place.entries }, audit: { slug: place.slug } };
    },
  },

  {
    method: "POST",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries$/,
    operation: "entry.create",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      let created: Entry | undefined;

      const stored = await mutate(ctx, slug, request, `places: nova entrada em ${slug}`, async (place) => {
        const entry: Entry = {
          id: mintEntryId(place),
          ...entryFields(request.body, request.principal),
          photos: [],
        };
        const { attach } = await claimPhotos(ctx, place, entry, request.body.photos);
        place.entries.push(entry);
        created = entry;
        return { place, attach };
      });

      return {
        status: 201,
        body: { entry: created, place: shapePlace(stored) },
        headers: { ETag: `"${stored.etag}"` },
        audit: { slug, entryId: created?.id },
      };
    },
  },

  {
    method: "GET",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries\/(?<id>[^/]+)$/,
    operation: "places.get",
    async handle(ctx, request) {
      const { place } = await ctx.vault.read(assertSlug(request.params.slug));
      const entry = findEntry(place, assertId(request.params.id, "entry id"));
      return { body: { entry }, audit: { slug: place.slug, entryId: entry.id } };
    },
  },

  {
    method: "PATCH",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries\/(?<id>[^/]+)$/,
    operation: "entry.update",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      const id = assertId(request.params.id, "entry id");
      let updated: Entry | undefined;

      const stored = await mutate(ctx, slug, request, `places: corrige entrada ${id} em ${slug}`, async (place) => {
        const entry = findEntry(place, id);
        Object.assign(entry, entryFields(request.body, request.principal, entry));
        updated = entry;
        return { place };
      });

      return {
        body: { entry: updated, place: shapePlace(stored) },
        headers: { ETag: `"${stored.etag}"` },
        audit: { slug, entryId: id },
      };
    },
  },

  {
    method: "DELETE",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries\/(?<id>[^/]+)$/,
    operation: "entry.delete",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      const id = assertId(request.params.id, "entry id");

      const stored = await mutate(ctx, slug, request, `places: remove entrada ${id} de ${slug}`, async (place) => {
        const entry = findEntry(place, id);
        place.entries = place.entries.filter((candidate) => candidate.id !== id);
        // The photos of a deleted visit have nowhere left to belong.
        return { place, remove: entry.photos.map((photo) => photo.file) };
      });

      return { body: shapePlace(stored), headers: { ETag: `"${stored.etag}"` }, audit: { slug, entryId: id } };
    },
  },

  // ── photos ─────────────────────────────────────────────────────────────────

  {
    method: "POST",
    pattern: /^\/photos$/,
    operation: "photo.upload",
    async handle(ctx, request) {
      const data = await readUpload(request.raw, ctx.config.photoMaxBytes);
      const staged = await ctx.photos.stage(data);

      const asText = (request.headers.get("accept") ?? "").includes("text/plain");
      const wantsDescription = asText || request.query.get("describe") === "true";

      // Described from the re-encoded copy, not the original: it is smaller,
      // so the round trip is quicker and costs less, and it is the image that
      // will actually be published.
      const description = wantsDescription
        ? await describeImage(
            new Uint8Array(await Bun.file(staged.path).arrayBuffer()),
            ctx.config.describe,
          )
        : null;

      // A caller that asks for text gets one short line back. That is what a
      // media pipeline pastes into a message for a model to read, and a few
      // hundred characters is all it is given — so the id comes first, where
      // truncation cannot reach it.
      if (asText) {
        const tail = description
          ? `${description} — passe este id ao registar a visita.`
          : "recebida, por guardar. Passe este id ao registar a visita.";
        return {
          status: 201,
          body: `foto:${staged.id} — ${tail}\n`,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          audit: { photoId: staged.id },
        };
      }

      return {
        status: 201,
        body: {
          id: staged.id,
          bytes: staged.bytes,
          width: staged.width,
          height: staged.height,
          ...(description ? { description } : {}),
        },
        audit: { photoId: staged.id },
      };
    },
  },

  {
    method: "POST",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries\/(?<id>[^/]+)\/photos$/,
    operation: "photo.attach",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      const id = assertId(request.params.id, "entry id");
      let entry: Entry | undefined;

      const stored = await mutate(ctx, slug, request, `places: fotos na entrada ${id} de ${slug}`, async (place) => {
        entry = findEntry(place, id);
        const { attach } = await claimPhotos(ctx, place, entry, request.body.photos);
        return { place, attach };
      });

      return {
        status: 201,
        body: { entry, place: shapePlace(stored) },
        headers: { ETag: `"${stored.etag}"` },
        audit: { slug, entryId: id },
      };
    },
  },

  {
    method: "PATCH",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries\/(?<id>[^/]+)\/photos\/(?<photoId>[^/]+)$/,
    operation: "photo.update",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      const id = assertId(request.params.id, "entry id");
      const photoId = assertId(request.params.photoId, "photo id");

      const stored = await mutate(ctx, slug, request, `places: legenda de ${photoId} em ${slug}`, async (place) => {
        const photo = findEntry(place, id).photos.find((candidate) => candidate.id === photoId);
        if (!photo) throw new NotFoundError(`no photo ${photoId} on entry ${id}`);
        photo.caption = optionalString(request.body.caption, "caption", 300);
        return { place };
      });

      return { body: shapePlace(stored), headers: { ETag: `"${stored.etag}"` }, audit: { slug, entryId: id, photoId } };
    },
  },

  {
    method: "DELETE",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries\/(?<id>[^/]+)\/photos\/(?<photoId>[^/]+)$/,
    operation: "photo.detach",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      const id = assertId(request.params.id, "entry id");
      const photoId = assertId(request.params.photoId, "photo id");

      const stored = await mutate(ctx, slug, request, `places: remove foto ${photoId} de ${slug}`, async (place) => {
        const entry = findEntry(place, id);
        const photo = entry.photos.find((candidate) => candidate.id === photoId);
        if (!photo) throw new NotFoundError(`no photo ${photoId} on entry ${id}`);
        entry.photos = entry.photos.filter((candidate) => candidate.id !== photoId);
        return { place, remove: [photo.file] };
      });

      return { body: shapePlace(stored), headers: { ETag: `"${stored.etag}"` }, audit: { slug, entryId: id, photoId } };
    },
  },

  // ── labels and maintenance ─────────────────────────────────────────────────

  {
    method: "GET",
    pattern: /^\/species$/,
    operation: "places.labels",
    async handle(ctx) {
      return { body: { species: ctx.index.listSpecies() } };
    },
  },

  {
    method: "GET",
    pattern: /^\/tags$/,
    operation: "places.labels",
    async handle(ctx) {
      return { body: { tags: ctx.index.listTags() } };
    },
  },

  {
    method: "POST",
    pattern: /^\/render$/,
    operation: "admin.render",
    async handle(ctx, request) {
      const all = request.query.get("all") === "true";
      const slugs = all
        ? await ctx.vault.list()
        : [assertSlug(requiredString(request.body.slug, "slug"))];

      const changed: string[] = [];
      for (const slug of slugs) {
        if (await ctx.vault.rerender(slug)) changed.push(slug);
      }

      // One commit for the lot. A template change is one decision, and its diff
      // should read as one.
      const committed = changed.length
        ? await ctx.vault.commitSection(
            all ? `places: re-render (${changed.length} locais)` : `places: re-render ${changed[0]}`,
          )
        : false;

      return { body: { considered: slugs.length, changed, committed } };
    },
  },

  {
    method: "POST",
    pattern: /^\/reindex$/,
    operation: "admin.reindex",
    async handle(ctx) {
      const stored = await ctx.vault.readAll();
      ctx.index.rebuild(stored);
      return { body: { indexed: stored.length } };
    },
  },
];

/**
 * The bytes of an upload, from a multipart form or from a raw body.
 *
 * Multipart is what `curl -F` sends, which is what a media pipeline is likely
 * to use. The raw path is there so a two-line script does not have to build a
 * multipart body to save a photo.
 */
async function readUpload(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file") ?? form.get("photo") ?? form.get("image");
    if (!(file instanceof File)) {
      throw new ValidationError("send the image as a form field named file");
    }
    if (file.size > maxBytes) throw new ValidationError("the image is larger than the limit");
    return new Uint8Array(await file.arrayBuffer());
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new ValidationError("the image is larger than the limit");
  return new Uint8Array(buffer);
}

export function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  let pathMatched = false;

  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    return { route, params: (match.groups ?? {}) as Record<string, string> };
  }

  if (pathMatched) throw new MethodNotAllowedError(`${method} is not allowed on ${path}`);
  return null;
}

export class MethodNotAllowedError extends Error {
  readonly status = 405;
  constructor(message: string) {
    super(message);
    this.name = "MethodNotAllowedError";
  }
}
