// entries.ts — the visits to a place, and correcting them.

import {
  assertDate,
  assertEntryType,
  assertId,
  assertSlug,
  mintEntryId,
  normaliseLabels,
  optionalRating,
  optionalString,
  type Entry,
} from "../../domain/model";
import { localDate } from "../../domain/time";
import type { Principal } from "../../security/acl";
import { findEntry, mutate, shapePlace, type Route } from "../api";
import { claimPhotos, renamePhotos } from "./photo-files";

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

export const ENTRY_ROUTES: Route[] = [
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
        // The photos were named when they arrived, which is usually before the
        // date and the species were right.
        const attach = renamePhotos(place, entry, ctx.vault.bundleDir(slug));
        updated = entry;
        return { place, attach };
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
];
