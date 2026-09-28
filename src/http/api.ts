// api.ts — what every route is given, what it returns, and the one way to write.
//
// Shared by the route files under routes/. Nothing here knows about a particular
// resource; what does lives next to the routes that need it.

import type { Operation, Principal } from "../security/acl";
import type { Config } from "../config";
import { localTimestamp } from "../domain/time";
import { speciesOf, type Entry, type Place } from "../domain/model";
import type { PhotoStore } from "../storage/photos";
import type { PlaceIndex } from "../storage/search";
import { NotFoundError, type StoredPlace, type Vault } from "../storage/vault";

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

export function ifMatch(headers: Headers): string | undefined {
  const value = headers.get("if-match");
  if (!value || value === "*") return undefined;
  return value.replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** Where the place reads as a note, for a caller that only has the API's word for it. */
export function placeUrl(config: Config, slug: string): string {
  return `${config.siteBaseUrl}/places/${slug}/`;
}

export function shapePlace(stored: StoredPlace) {
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

export function findEntry(place: Place, id: string): Entry {
  const entry = place.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new NotFoundError(`no entry ${id} at ${place.slug}`);
  return entry;
}

/**
 * Read, change, write, reindex.
 *
 * The single path through which every mutation passes. Anything that skips it
 * risks a record on disk the index has never seen.
 */
export async function mutate(
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
