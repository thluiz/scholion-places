// model.ts — what a place is, and what counts as a valid one.
//
// The record on disk is JSON, and this file is the only place that decides its
// shape. Everything downstream — the renderer, the index, the routes — reads
// these types and trusts that validation already happened here.
//
// One decision carries most of the weight: entries and photos have opaque,
// stable ids. Without them there is no way to say "fix that visit" — you can
// only rewrite the whole place and hope. Dates are not ids: two visits on one
// day are ordinary, and correcting a date must not change what you are
// pointing at.

import { isValidCoords, roundCoords, slugify, type Coords } from "./geo";

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export type PlaceKind = "flores" | "restaurante";
export type EntryType = "sighting" | "visit";

export const PLACE_KINDS: readonly PlaceKind[] = ["flores", "restaurante"];
export const ENTRY_TYPES: readonly EntryType[] = ["sighting", "visit"];

export interface PhotoRef {
  id: string;
  file: string;
  caption?: string;
}

export interface Entry {
  id: string;
  date: string; // YYYY-MM-DD
  type: EntryType;
  by: string;
  species?: string[];
  dish?: string;
  rating?: number; // 1..5
  note?: string;
  photos: PhotoRef[];
}

export interface Place {
  slug: string;
  title: string;
  kind: PlaceKind[];
  tags: string[];
  summary?: string;
  address?: string;
  coords: Coords;
  body?: string;
  created: string; // ISO 8601 with offset
  updated: string;
  entries: Entry[];
}

// ── ids ──────────────────────────────────────────────────────────────────────

const ID_ALPHABET = "0123456789abcdef";

function randomId(prefix: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = prefix;
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

/**
 * A short id, unique among the ones already taken.
 *
 * Short because a person types it into a correction, and reads it in a commit
 * message. Uniqueness is only ever checked within one place, where the
 * population is a handful of entries — so five hex characters is generous.
 */
export function mintId(prefix: string, taken: Iterable<string>, length = 5): string {
  const used = new Set(taken);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = randomId(prefix, length);
    if (!used.has(candidate)) return candidate;
  }
  // Unreachable for any realistic population, but silence is worse than noise.
  throw new Error(`could not mint a unique id with prefix ${prefix}`);
}

export function mintEntryId(place: Pick<Place, "entries">): string {
  return mintId("e", place.entries.map((entry) => entry.id));
}

export function mintPhotoId(entry: Pick<Entry, "photos">): string {
  return mintId("p", entry.photos.map((photo) => photo.id));
}

// ── field validation ─────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z][0-9a-f]+$/;

export function assertSlug(value: unknown, field = "slug"): string {
  if (typeof value !== "string" || !SLUG_RE.test(value)) {
    throw new ValidationError(`${field} must be lowercase letters, digits and hyphens`);
  }
  if (value.includes("..") || value.length > 80) {
    throw new ValidationError(`${field} is not a usable directory name`);
  }
  return value;
}

export function assertId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value) || value.length > 16) {
    throw new ValidationError(`${field} is not a valid id`);
  }
  return value;
}

/**
 * A calendar date, checked against the calendar.
 *
 * The regex alone accepts 2026-02-31. Round-tripping through Date catches it,
 * which matters because a wrong date is exactly the mistake this API exists to
 * let you correct — it should be hard to make in the first place.
 */
export function assertDate(value: unknown, field = "date"): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new ValidationError(`${field} must be a date as YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${field} is not a real date: ${value}`);
  }
  return value;
}

export function optionalString(value: unknown, field: string, maxLength = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} is longer than ${maxLength} characters`);
  }
  return trimmed;
}

export function requiredString(value: unknown, field: string, maxLength = 300): string {
  const result = optionalString(value, field, maxLength);
  if (!result) throw new ValidationError(`${field} is required`);
  return result;
}

/**
 * A list of short labels, normalised the way slugs are.
 *
 * Species and tags are matched across the whole collection, so
 * "Papoila-das-searas" and "papoila das searas" have to become one thing or the
 * search for either finds half the answer.
 */
export function normaliseLabels(value: unknown, field: string, limit = 40): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list`);
  if (value.length > limit) throw new ValidationError(`${field} has more than ${limit} items`);

  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new ValidationError(`${field} must contain only strings`);
    const label = slugify(item, 60);
    if (label) seen.add(label);
  }
  return [...seen].sort();
}

export function assertKinds(value: unknown): PlaceKind[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const kinds = new Set<PlaceKind>();
  for (const item of list) {
    if (!PLACE_KINDS.includes(item as PlaceKind)) {
      throw new ValidationError(`kind must be one of ${PLACE_KINDS.join(", ")}`);
    }
    kinds.add(item as PlaceKind);
  }
  return [...kinds];
}

export function assertEntryType(value: unknown): EntryType {
  if (value === undefined || value === null) return "sighting";
  if (!ENTRY_TYPES.includes(value as EntryType)) {
    throw new ValidationError(`type must be one of ${ENTRY_TYPES.join(", ")}`);
  }
  return value as EntryType;
}

export function assertCoords(value: unknown, decimals: number): Coords {
  if (!isValidCoords(value)) {
    throw new ValidationError("coords must be { lat, lon } within the valid ranges");
  }
  return roundCoords(value, decimals);
}

export function optionalRating(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new ValidationError("rating must be a whole number from 1 to 5");
  }
  return value;
}

// ── derived views ────────────────────────────────────────────────────────────

/**
 * Every species ever recorded at a place, in one sorted list.
 *
 * Written into the generated frontmatter so Hugo can build a `species`
 * taxonomy — which is what answers "where else have we seen this?" without any
 * code of ours. Derived, never edited: it is rebuilt on every write.
 */
export function speciesOf(place: Pick<Place, "entries">): string[] {
  const all = new Set<string>();
  for (const entry of place.entries) {
    for (const species of entry.species ?? []) all.add(species);
  }
  return [...all].sort();
}

/** Entries oldest first. The file reads as a chronology, so it is stored as one. */
export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
}

export function firstSeen(place: Pick<Place, "entries">): string | undefined {
  return sortEntries(place.entries)[0]?.date;
}

export function lastSeen(place: Pick<Place, "entries">): string | undefined {
  return sortEntries(place.entries).at(-1)?.date;
}

// ── whole-record validation ──────────────────────────────────────────────────

/**
 * Validate and normalise a record read from disk.
 *
 * A `place.json` edited by hand is a supported way to work, so this has to be
 * forgiving about what is missing and strict about what is wrong. Anything it
 * returns is safe for the renderer and the index to consume without checking
 * again.
 */
export function parsePlace(raw: unknown, coordDecimals = 6): Place {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("a place record must be a JSON object");
  }
  const input = raw as Record<string, unknown>;

  const title = requiredString(input.title, "title");
  const slug = assertSlug(input.slug ?? slugify(title));
  const coords = assertCoords(input.coords, coordDecimals);

  const entryIds = new Set<string>();
  const rawEntries = input.entries ?? [];
  if (!Array.isArray(rawEntries)) throw new ValidationError("entries must be a list");

  const entries: Entry[] = rawEntries.map((item, position) => {
    if (typeof item !== "object" || item === null) {
      throw new ValidationError(`entry ${position} must be an object`);
    }
    const entry = item as Record<string, unknown>;
    const id = assertId(entry.id, `entries[${position}].id`);
    if (entryIds.has(id)) throw new ValidationError(`duplicate entry id: ${id}`);
    entryIds.add(id);

    const photoIds = new Set<string>();
    const rawPhotos = entry.photos ?? [];
    if (!Array.isArray(rawPhotos)) throw new ValidationError(`entries[${position}].photos must be a list`);

    const photos: PhotoRef[] = rawPhotos.map((photoItem, photoPosition) => {
      if (typeof photoItem !== "object" || photoItem === null) {
        throw new ValidationError(`entries[${position}].photos[${photoPosition}] must be an object`);
      }
      const photo = photoItem as Record<string, unknown>;
      const photoId = assertId(photo.id, `entries[${position}].photos[${photoPosition}].id`);
      if (photoIds.has(photoId)) throw new ValidationError(`duplicate photo id: ${photoId}`);
      photoIds.add(photoId);
      return {
        id: photoId,
        file: assertPhotoFile(photo.file, `entries[${position}].photos[${photoPosition}].file`),
        caption: optionalString(photo.caption, "caption", 300),
      };
    });

    return {
      id,
      date: assertDate(entry.date, `entries[${position}].date`),
      type: assertEntryType(entry.type),
      by: requiredString(entry.by, `entries[${position}].by`, 60),
      species: normaliseLabels(entry.species, `entries[${position}].species`),
      dish: optionalString(entry.dish, "dish", 200),
      rating: optionalRating(entry.rating),
      note: optionalString(entry.note, "note", 2000),
      photos,
    };
  });

  const now = new Date().toISOString();
  return {
    slug,
    title,
    kind: assertKinds(input.kind),
    tags: normaliseLabels(input.tags, "tags"),
    summary: optionalString(input.summary, "summary", 400),
    address: optionalString(input.address, "address", 300),
    coords,
    body: optionalString(input.body, "body", 20_000),
    created: optionalString(input.created, "created", 40) ?? now,
    updated: optionalString(input.updated, "updated", 40) ?? now,
    entries: sortEntries(entries),
  };
}

/**
 * A photo filename that stays inside the bundle.
 *
 * Photo names come from a caller and end up as a path join, so this is the
 * boundary that stops `../../../etc/passwd` from becoming a valid attachment.
 */
export function assertPhotoFile(value: unknown, field = "file"): string {
  const file = requiredString(value, field, 200);
  if (!/^[a-z0-9][a-z0-9._-]*\.(jpg|jpeg|png|webp)$/i.test(file) || file.includes("..")) {
    throw new ValidationError(`${field} is not a valid image filename`);
  }
  return file;
}

/** Serialise for disk: stable key order, two-space indent, trailing newline. */
export function serialisePlace(place: Place): string {
  const ordered = {
    slug: place.slug,
    title: place.title,
    kind: place.kind,
    tags: place.tags,
    summary: place.summary,
    address: place.address,
    coords: place.coords,
    body: place.body,
    created: place.created,
    updated: place.updated,
    entries: sortEntries(place.entries).map((entry) => ({
      id: entry.id,
      date: entry.date,
      type: entry.type,
      by: entry.by,
      species: entry.species?.length ? entry.species : undefined,
      dish: entry.dish,
      rating: entry.rating,
      note: entry.note,
      photos: entry.photos.map((photo) => ({
        id: photo.id,
        file: photo.file,
        caption: photo.caption,
      })),
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
