// geo.ts — slugs and distances.
//
// Two unrelated jobs live here because both answer the same question: is this
// the same place as that one? A slug collision and an eighty-metre gap are the
// two ways the collection ends up with one field recorded twice.
//
// Nothing here touches disk or knows what a Place is.

export const EARTH_RADIUS_M = 6_371_008.8;

/**
 * How close two places may be before we assume they are the same one.
 *
 * A phone's fix drifts by tens of metres under trees, so two visits to the same
 * roadside end up with different coordinates. Eighty metres is wide enough to
 * absorb that and narrow enough to keep two neighbouring fields apart.
 */
export const NEIGHBOUR_RADIUS_M = 80;

export interface Coords {
  lat: number;
  lon: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * A URL-safe, accent-free slug.
 *
 * Derived from the title once, at creation, and then frozen: the published URL
 * outlives any later rename. See the rename route for the deliberate exception.
 */
export function slugify(input: string, maxLength = 60): string {
  const stripped = input
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // combining marks left over from the decomposition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (stripped.length <= maxLength) return stripped;

  // Cut on a separator so the slug never ends mid-word.
  const cut = stripped.slice(0, maxLength);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > maxLength / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

/** Metres between two points, over a sphere. Good to a few parts per thousand. */
export function distanceMeters(a: Coords, b: Coords): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A box that certainly contains every point within `radiusM`, and some points
 * outside it.
 *
 * This is the cheap first pass: SQL narrows by the box, then `distanceMeters`
 * rejects the corners. With a few thousand rows the box is a convenience, not a
 * necessity — but it keeps the query honest as the collection grows.
 */
export function boundingBox(centre: Coords, radiusM: number): BoundingBox {
  const toRad = Math.PI / 180;
  const latDelta = radiusM / EARTH_RADIUS_M / toRad;

  // Longitude degrees shrink towards the poles. Guard the cosine so a point at
  // the pole widens the box instead of dividing by zero.
  const cosLat = Math.max(Math.cos(centre.lat * toRad), 1e-9);
  const lonDelta = Math.min(180, radiusM / (EARTH_RADIUS_M * cosLat) / toRad);

  return {
    minLat: Math.max(-90, centre.lat - latDelta),
    maxLat: Math.min(90, centre.lat + latDelta),
    minLon: centre.lon - lonDelta,
    maxLon: centre.lon + lonDelta,
  };
}

export function isValidCoords(value: unknown): value is Coords {
  if (typeof value !== "object" || value === null) return false;
  const { lat, lon } = value as Partial<Coords>;
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Round coordinates to a fixed number of decimals.
 *
 * Six decimals pin a point to roughly ten centimetres. The collection is
 * published, so the precision written to disk is a deliberate choice rather
 * than whatever the phone happened to report.
 */
export function roundCoords(coords: Coords, decimals: number): Coords {
  const factor = 10 ** decimals;
  return {
    lat: Math.round(coords.lat * factor) / factor,
    lon: Math.round(coords.lon * factor) / factor,
  };
}
