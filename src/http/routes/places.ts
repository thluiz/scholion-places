// places.ts — finding, creating, correcting and removing a place.

import { NEIGHBOUR_RADIUS_M, distanceMeters, slugify } from "../../domain/geo";
import {
  ValidationError,
  assertCoords,
  assertDate,
  assertKinds,
  assertSlug,
  normaliseLabels,
  optionalString,
  requiredString,
  type Place,
} from "../../domain/model";
import { localTimestamp } from "../../domain/time";
import type { SearchQuery } from "../../storage/search";
import { ConflictError } from "../../storage/vault";
import { ifMatch, mutate, placeUrl, shapePlace, type ApiContext, type Route } from "../api";

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
    updatedSince: query.get("updated_since") ? assertDate(query.get("updated_since"), "updated_since") : undefined,
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

export const PLACE_ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/places$/,
    operation: "places.search",
    async handle(ctx, request) {
      const result = ctx.index.search(parseSearch(request.query));
      return {
        body: {
          ...result,
          results: result.results.map((hit) => ({ ...hit, url: placeUrl(ctx.config, hit.slug) })),
        },
      };
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

        const closest = near[0];
        if (closest) {
          throw new ConflictError(
            `there is already a place ${closest.distanceM} m away: ${closest.slug} (${closest.title}). ` +
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
];
