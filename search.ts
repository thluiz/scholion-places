// search.ts — the search index, which is disposable on purpose.
//
// (Named for what it does rather than `index.ts`: a file called index in the
// repository root is the one name a module resolver treats as special.)
//
// The records are the truth. This is a cache with a query language: it is built
// from the JSON at boot, refreshed per file when an mtime moves, and can be
// deleted at any moment with no loss. That is what makes editing a place.json
// by hand a first-class way to work rather than a violation — the index catches
// up, and nobody has to migrate anything.
//
// FTS5 is tokenised with `remove_diacritics 2`, so "acafrao" finds "açafrão".
// In a Portuguese collection that is not a nicety: nobody types the cedilla on
// a phone, on a trail, in the rain.
//
// Geography needs no extension. Latitude and longitude are columns, "near here"
// is a bounding box in SQL followed by a haversine over the handful of rows
// that survive it. At a few thousand records an R-tree would be ceremony.

import { Database } from "bun:sqlite";

import { boundingBox, distanceMeters, type Coords } from "./geo";
import { firstSeen, lastSeen, speciesOf } from "./model";
import type { StoredPlace } from "./vault";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS places (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  species     TEXT NOT NULL DEFAULT '',
  summary     TEXT,
  address     TEXT,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  first_seen  TEXT,
  last_seen   TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0,
  photo_count INTEGER NOT NULL DEFAULT 0,
  created     TEXT NOT NULL DEFAULT '',
  updated     TEXT NOT NULL DEFAULT '',
  mtime_ms    REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entries (
  slug        TEXT NOT NULL,
  id          TEXT NOT NULL,
  date        TEXT NOT NULL,
  month       INTEGER NOT NULL,
  type        TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  species     TEXT NOT NULL DEFAULT '',
  dish        TEXT,
  rating      INTEGER,
  note        TEXT,
  photo_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, id)
);

CREATE INDEX IF NOT EXISTS entries_by_month   ON entries(month);
CREATE INDEX IF NOT EXISTS entries_by_date    ON entries(date);
CREATE INDEX IF NOT EXISTS places_by_position ON places(lat, lon);

CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5(
  slug UNINDEXED,
  title,
  summary,
  address,
  body,
  tags,
  species,
  notes,
  tokenize = "unicode61 remove_diacritics 2"
);
`;

export interface SearchQuery {
  q?: string;
  kind?: string;
  tag?: string;
  species?: string;
  /** 1–12. Answers "what flowers here in April", across every year. */
  month?: number;
  near?: Coords;
  radiusKm?: number;
  since?: string;
  until?: string;
  /** Only places whose record was created or changed on or after this date. */
  updatedSince?: string;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  slug: string;
  title: string;
  kind: string[];
  tags: string[];
  species: string[];
  summary?: string;
  address?: string;
  coords: Coords;
  firstSeen?: string;
  lastSeen?: string;
  entryCount: number;
  photoCount: number;
  distanceM?: number;
  created: string;
  updated: string;
}

export interface SearchResult {
  total: number;
  results: SearchHit[];
}

export interface LabelCount {
  label: string;
  places: number;
}

const csv = (values: string[]): string => (values.length ? `,${values.join(",")},` : "");
const uncsv = (value: string): string[] => value.split(",").filter(Boolean);

interface PlaceRow {
  slug: string;
  title: string;
  kind: string;
  tags: string;
  species: string;
  summary: string | null;
  address: string | null;
  lat: number;
  lon: number;
  first_seen: string | null;
  last_seen: string | null;
  entry_count: number;
  photo_count: number;
  created: string;
  updated: string;
  mtime_ms: number;
}

function toHit(row: PlaceRow): SearchHit {
  return {
    slug: row.slug,
    title: row.title,
    kind: uncsv(row.kind),
    tags: uncsv(row.tags),
    species: uncsv(row.species),
    summary: row.summary ?? undefined,
    address: row.address ?? undefined,
    coords: { lat: row.lat, lon: row.lon },
    firstSeen: row.first_seen ?? undefined,
    lastSeen: row.last_seen ?? undefined,
    entryCount: row.entry_count,
    photoCount: row.photo_count,
    created: row.created,
    updated: row.updated,
  };
}

/**
 * Escape a user's words into an FTS5 MATCH expression.
 *
 * Quoting every term is what stops a stray hyphen or quote from being read as
 * query syntax and returning an error instead of results. A trailing `*` on the
 * last term makes the search feel like it is completing as you type.
 */
export function toMatchExpression(input: string): string | null {
  const terms = input
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => term.length > 0);
  if (!terms.length) return null;

  return terms
    .map((term, position) => (position === terms.length - 1 ? `"${term}"*` : `"${term}"`))
    .join(" AND ");
}

export class PlaceIndex {
  private readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Rebuild from scratch. Cheap enough at this scale to be the safe default. */
  rebuild(stored: StoredPlace[]): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM places");
      this.db.run("DELETE FROM entries");
      this.db.run("DELETE FROM places_fts");
      for (const item of stored) this.insert(item);
    })();
  }

  upsert(stored: StoredPlace): void {
    this.db.transaction(() => {
      this.forget(stored.place.slug);
      this.insert(stored);
    })();
  }

  forget(slug: string): void {
    this.db.run("DELETE FROM places WHERE slug = ?", [slug]);
    this.db.run("DELETE FROM entries WHERE slug = ?", [slug]);
    this.db.run("DELETE FROM places_fts WHERE slug = ?", [slug]);
  }

  /** What the index believes about each record's freshness, for the mtime sweep. */
  knownMtimes(): Map<string, number> {
    const rows = this.db.query<{ slug: string; mtime_ms: number }, []>(
      "SELECT slug, mtime_ms FROM places",
    ).all();
    return new Map(rows.map((row) => [row.slug, row.mtime_ms]));
  }

  private insert({ place, mtimeMs }: StoredPlace): void {
    const species = speciesOf(place);
    const photoCount = place.entries.reduce((total, entry) => total + entry.photos.length, 0);

    this.db.run(
      `INSERT INTO places
         (slug, title, kind, tags, species, summary, address, lat, lon,
          first_seen, last_seen, entry_count, photo_count, created, updated, mtime_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        place.slug,
        place.title,
        csv(place.kind),
        csv(place.tags),
        csv(species),
        place.summary ?? null,
        place.address ?? null,
        place.coords.lat,
        place.coords.lon,
        firstSeen(place) ?? null,
        lastSeen(place) ?? null,
        place.entries.length,
        photoCount,
        place.created,
        place.updated,
        mtimeMs,
      ],
    );

    for (const entry of place.entries) {
      this.db.run(
        `INSERT INTO entries
           (slug, id, date, month, type, recorded_by, species, dish, rating, note, photo_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          place.slug,
          entry.id,
          entry.date,
          Number(entry.date.slice(5, 7)),
          entry.type,
          entry.by,
          csv(entry.species ?? []),
          entry.dish ?? null,
          entry.rating ?? null,
          entry.note ?? null,
          entry.photos.length,
        ],
      );
    }

    // One FTS row per place: a search is a question about a place, and the
    // notes of every visit are part of what the place is.
    this.db.run(
      `INSERT INTO places_fts (slug, title, summary, address, body, tags, species, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        place.slug,
        place.title,
        place.summary ?? "",
        place.address ?? "",
        place.body ?? "",
        place.tags.join(" "),
        [...species, ...species.map((name) => name.replace(/-/g, " "))].join(" "),
        place.entries.map((entry) => [entry.note, entry.dish].filter(Boolean).join(" ")).join(" "),
      ],
    );
  }

  // ── queries ────────────────────────────────────────────────────────────────

  get(slug: string): SearchHit | null {
    const row = this.db.query<PlaceRow, [string]>("SELECT * FROM places WHERE slug = ?").get(slug);
    return row ? toHit(row) : null;
  }

  count(): number {
    return (
      this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM places").get()?.n ?? 0
    );
  }

  search(query: SearchQuery): SearchResult {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (query.q) {
      const expression = toMatchExpression(query.q);
      if (expression) {
        conditions.push("p.slug IN (SELECT slug FROM places_fts WHERE places_fts MATCH ?)");
        params.push(expression);
      }
    }

    if (query.kind) {
      conditions.push("p.kind LIKE ?");
      params.push(`%,${query.kind},%`);
    }
    if (query.tag) {
      conditions.push("p.tags LIKE ?");
      params.push(`%,${query.tag},%`);
    }
    if (query.species) {
      conditions.push("p.species LIKE ?");
      params.push(`%,${query.species},%`);
    }

    // Entry-level filters ask whether the place has *any* visit that matches.
    // A place is the unit of an answer; a visit is the evidence for it.
    if (query.month !== undefined) {
      conditions.push("EXISTS (SELECT 1 FROM entries e WHERE e.slug = p.slug AND e.month = ?)");
      params.push(query.month);
    }
    if (query.since) {
      conditions.push("EXISTS (SELECT 1 FROM entries e WHERE e.slug = p.slug AND e.date >= ?)");
      params.push(query.since);
    }
    if (query.until) {
      conditions.push("EXISTS (SELECT 1 FROM entries e WHERE e.slug = p.slug AND e.date <= ?)");
      params.push(query.until);
    }
    // Unlike since/until, this asks about the record itself — created or
    // touched on or after this date — not about when a visit happened.
    // Lexical comparison works because `updated` is an ISO timestamp with an
    // offset, and any such timestamp on a date sorts >= that date's prefix.
    if (query.updatedSince) {
      conditions.push("p.updated >= ?");
      params.push(query.updatedSince);
    }

    const radiusM = (query.radiusKm ?? 5) * 1000;
    if (query.near) {
      const box = boundingBox(query.near, radiusM);
      conditions.push("p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?");
      params.push(box.minLat, box.maxLat, box.minLon, box.maxLon);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .query<PlaceRow, (string | number)[]>(`SELECT p.* FROM places p ${where}`)
      .all(...params);

    let hits = rows.map(toHit);

    if (query.near) {
      const centre = query.near;
      hits = hits
        .map((hit) => ({ ...hit, distanceM: Math.round(distanceMeters(centre, hit.coords)) }))
        .filter((hit) => (hit.distanceM ?? 0) <= radiusM)
        .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
    } else if (query.updatedSince) {
      // "What's new" is a question about freshness, not about the last visit.
      hits.sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title));
    } else {
      hits.sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") || a.title.localeCompare(b.title));
    }

    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(Math.max(1, query.limit ?? 25), 200);
    return { total: hits.length, results: hits.slice(offset, offset + limit) };
  }

  nearby(centre: Coords, radiusKm = 1): SearchResult {
    return this.search({ near: centre, radiusKm, limit: 50 });
  }

  listSpecies(): LabelCount[] {
    return this.labelCounts("species");
  }

  listTags(): LabelCount[] {
    return this.labelCounts("tags");
  }

  private labelCounts(column: "species" | "tags"): LabelCount[] {
    const rows = this.db
      .query<{ value: string }, []>(`SELECT ${column} AS value FROM places`)
      .all();

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const label of uncsv(row.value)) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, places]) => ({ label, places }))
      .sort((a, b) => b.places - a.places || a.label.localeCompare(b.label));
  }
}

/**
 * Bring the index in line with what is on disk.
 *
 * Compares mtimes rather than trusting that every change came through the API.
 * A pull from the remote, or a person with a text editor, both land here.
 */
export async function syncIndex(
  index: PlaceIndex,
  readAll: () => Promise<StoredPlace[]>,
): Promise<{ added: number; updated: number; removed: number }> {
  const known = index.knownMtimes();
  const stored = await readAll();
  const seen = new Set<string>();

  let added = 0;
  let updated = 0;

  for (const item of stored) {
    seen.add(item.place.slug);
    const previous = known.get(item.place.slug);
    if (previous === undefined) {
      index.upsert(item);
      added++;
    } else if (previous !== item.mtimeMs) {
      index.upsert(item);
      updated++;
    }
  }

  let removed = 0;
  for (const slug of known.keys()) {
    if (!seen.has(slug)) {
      index.forget(slug);
      removed++;
    }
  }

  return { added, updated, removed };
}
