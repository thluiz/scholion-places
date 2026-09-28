// routes.ts — the API surface: every route, and how a request finds one.
//
// The handlers live in routes/, one file per resource. Three things are worth
// knowing before reading them:
//
//   1. Every mutation reads the record, changes it in memory, and writes the
//      whole thing back — through `mutate` in api.ts. There is no partial write
//      and no in-place edit of a file, so a failure halfway leaves the previous
//      version intact.
//
//   2. Entries and photos are addressed by opaque id, never by date or
//      position. That is what makes "fix the visit I got wrong" expressible at
//      all, and it is the correction the first draft of this service could not
//      make.
//
//   3. `If-Match` is honoured on every write to an existing record. There are
//      two writers — a client and a person with a text editor — so a lost
//      update is a matter of when, not whether.

import type { Route } from "./api";
import { ADMIN_ROUTES } from "./routes/admin";
import { ENTRY_ROUTES } from "./routes/entries";
import { PHOTO_ROUTES } from "./routes/photos";
import { PLACE_ROUTES } from "./routes/places";

export type { ApiContext, ApiRequest, ApiResult, Route } from "./api";

export const ROUTES: Route[] = [...PLACE_ROUTES, ...ENTRY_ROUTES, ...PHOTO_ROUTES, ...ADMIN_ROUTES];

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
