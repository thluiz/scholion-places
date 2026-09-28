// admin.ts — the label lists, and the two maintenance jobs.

import { assertSlug, requiredString } from "../../domain/model";
import type { Route } from "../api";

export const ADMIN_ROUTES: Route[] = [
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
