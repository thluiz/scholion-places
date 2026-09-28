// photo-files.ts — what a photograph is called in the bundle.
//
// Used by both the entry routes and the photo routes: an entry can arrive with
// its photos, and correcting an entry renames them.

import { join } from "node:path";

import { slugify } from "../../domain/geo";
import { ValidationError, mintPhotoId, type Entry, type Place } from "../../domain/model";
import { photoFilename } from "../../storage/photos";
import type { ApiContext } from "../api";

/** Every photo filename already in use at a place, so a new one does not collide. */
function takenFilenames(place: Place): string[] {
  return place.entries.flatMap((entry) => entry.photos.map((photo) => photo.file));
}

/**
 * What a photo of this visit should be called after the date, minus extension.
 *
 * Species first, because that is what the picture is of. A meal falls back to
 * the dish. A visit with neither still gets a dated name rather than nothing.
 */
function photoLabels(entry: Entry): string[] {
  if (entry.species?.length) return entry.species;
  const dish = entry.dish ? slugify(entry.dish, 40) : "";
  return dish ? [dish] : [];
}

/**
 * Rename an entry's photos to match what the entry now says.
 *
 * Photos are usually attached before the details are right: the pictures arrive,
 * then the date gets corrected and the species named. Leaving the filenames
 * where they landed means a bundle whose files claim a date the visit does not
 * have — which defeats the point of naming them after the visit at all, since
 * the name is what identifies a photograph pulled out of the repository alone.
 *
 * Cheap in git: the bytes do not change, so a rename stores no new blob.
 */
export function renamePhotos(place: Place, entry: Entry, bundleDir: string): { name: string; from: string }[] {
  const labels = photoLabels(entry);
  const others = place.entries
    .filter((candidate) => candidate.id !== entry.id)
    .flatMap((candidate) => candidate.photos.map((photo) => photo.file));

  const moves: { name: string; from: string }[] = [];
  const taken = [...others];

  for (const photo of entry.photos) {
    const wanted = photoFilename(entry.date, labels, taken);
    if (wanted === photo.file) {
      taken.push(photo.file);
      continue;
    }
    moves.push({ name: wanted, from: join(bundleDir, photo.file) });
    photo.file = wanted;
    taken.push(wanted);
  }

  return moves;
}

/**
 * Claim staged photos and work out what each one is called in the bundle.
 *
 * Naming happens here, not in the photo store, because the name is derived from
 * the visit — its date and what was seen — and the store knows nothing about
 * visits.
 */
export async function claimPhotos(
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
    const name = photoFilename(entry.date, photoLabels(entry), taken);

    taken.push(name);
    attach.push({ name, from: source });
    entry.photos.push({ id: mintPhotoId(entry), file: name });
  }

  return { attach };
}
