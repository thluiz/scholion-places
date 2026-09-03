// model.test.ts
//
// The assertions that matter here are the refusals and the round-trips. A
// validator that only proves the good input passes proves nothing: a function
// returning its argument unchanged would pass that test.

import { describe, expect, test } from "bun:test";

import {
  ValidationError,
  assertDate,
  assertEntryType,
  assertKinds,
  assertPhotoFile,
  assertSlug,
  firstSeen,
  lastSeen,
  mintId,
  normaliseLabels,
  optionalRating,
  parsePlace,
  serialisePlace,
  sortEntries,
  speciesOf,
  type Place,
} from "./model";

import { boundingBox, distanceMeters, roundCoords, slugify } from "./geo";

function samplePlace(overrides: Partial<Place> = {}): Place {
  return parsePlace({
    slug: "fonte-da-pipa",
    title: "Fonte da Pipa",
    kind: ["flores"],
    tags: ["Serra da Estrela"],
    coords: { lat: 40.32611, lon: -7.61389 },
    created: "2026-04-12T10:12:00+01:00",
    updated: "2026-08-31T09:40:00+01:00",
    entries: [
      {
        id: "e7f3a2",
        date: "2026-04-12",
        type: "sighting",
        by: "thiago",
        species: ["Papoila-das-searas", "malmequer bravo"],
        note: "campo todo vermelho no lado sul",
        photos: [{ id: "p2c81f", file: "2026-04-12-papoila.jpg" }],
      },
      {
        id: "e9b104",
        date: "2026-08-31",
        type: "sighting",
        by: "thilia",
        species: ["cardo"],
        photos: [],
      },
    ],
    ...overrides,
  });
}

describe("slugify", () => {
  test("strips accents and punctuation", () => {
    expect(slugify("Açafrão-bravo, na Serra")).toBe("acafrao-bravo-na-serra");
  });

  test("never ends mid-word or with a separator", () => {
    const slug = slugify("uma frase bastante longa que passa do limite imposto", 30);
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("uma-frase-bastante-longa-que");
  });

  test("collapses runs of separators", () => {
    expect(slugify("  --  Fonte   da   Pipa  -- ")).toBe("fonte-da-pipa");
  });
});

describe("geography", () => {
  test("distance between two known points", () => {
    // Roughly 111 km: one degree of latitude.
    const metres = distanceMeters({ lat: 40, lon: -7 }, { lat: 41, lon: -7 });
    expect(metres).toBeGreaterThan(110_500);
    expect(metres).toBeLessThan(111_500);
  });

  test("a bounding box contains every point inside the radius", () => {
    const centre = { lat: 40.32611, lon: -7.61389 };
    const box = boundingBox(centre, 80);

    // North, south, east and west edges of the circle must all be inside.
    const northish = { lat: centre.lat + 0.0006, lon: centre.lon };
    const eastish = { lat: centre.lat, lon: centre.lon + 0.0008 };
    for (const point of [northish, eastish]) {
      expect(distanceMeters(centre, point)).toBeLessThan(80);
      expect(point.lat).toBeGreaterThanOrEqual(box.minLat);
      expect(point.lat).toBeLessThanOrEqual(box.maxLat);
      expect(point.lon).toBeGreaterThanOrEqual(box.minLon);
      expect(point.lon).toBeLessThanOrEqual(box.maxLon);
    }
  });

  test("a box near the pole does not divide by zero", () => {
    const box = boundingBox({ lat: 90, lon: 0 }, 1000);
    expect(Number.isFinite(box.minLon)).toBe(true);
    expect(box.maxLon - box.minLon).toBeLessThanOrEqual(360);
  });

  test("rounding coordinates is what limits published precision", () => {
    expect(roundCoords({ lat: 40.3261149, lon: -7.6138951 }, 4)).toEqual({
      lat: 40.3261,
      lon: -7.6139,
    });
  });
});

describe("ids", () => {
  test("minted ids avoid the ones already taken", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) taken.add(mintId("e", taken));
    expect(taken.size).toBe(200);
    for (const id of taken) expect(id).toMatch(/^e[0-9a-f]{5}$/);
  });
});

describe("field validation refuses bad input", () => {
  test("a date that is not on the calendar", () => {
    expect(() => assertDate("2026-02-31")).toThrow(ValidationError);
    expect(() => assertDate("12/04/2026")).toThrow(ValidationError);
    expect(assertDate("2026-04-12")).toBe("2026-04-12");
  });

  test("a slug that would escape the content directory", () => {
    expect(() => assertSlug("../etc")).toThrow(ValidationError);
    expect(() => assertSlug("Fonte da Pipa")).toThrow(ValidationError);
    expect(assertSlug("fonte-da-pipa")).toBe("fonte-da-pipa");
  });

  test("a photo filename that would escape the bundle", () => {
    expect(() => assertPhotoFile("../../../etc/passwd")).toThrow(ValidationError);
    expect(() => assertPhotoFile("notes.txt")).toThrow(ValidationError);
    expect(() => assertPhotoFile("../x.jpg")).toThrow(ValidationError);
    expect(assertPhotoFile("2026-04-12-papoila.jpg")).toBe("2026-04-12-papoila.jpg");
  });

  test("a kind outside the two we know", () => {
    expect(() => assertKinds(["museu"])).toThrow(ValidationError);
    expect(assertKinds(["flores", "flores"])).toEqual(["flores"]);
  });

  test("an entry type outside the two we know", () => {
    expect(() => assertEntryType("almoco")).toThrow(ValidationError);
    expect(assertEntryType(undefined)).toBe("sighting");
  });

  test("a rating outside one to five", () => {
    expect(() => optionalRating(0)).toThrow(ValidationError);
    expect(() => optionalRating(6)).toThrow(ValidationError);
    expect(() => optionalRating(4.5)).toThrow(ValidationError);
    expect(optionalRating(4)).toBe(4);
  });

  test("a place with no title", () => {
    expect(() => parsePlace({ coords: { lat: 1, lon: 1 } })).toThrow(ValidationError);
  });

  test("a place with coordinates off the globe", () => {
    expect(() => parsePlace({ title: "x", coords: { lat: 91, lon: 0 } })).toThrow(ValidationError);
    expect(() => parsePlace({ title: "x", coords: "40,-7" })).toThrow(ValidationError);
  });

  test("two entries sharing an id", () => {
    expect(() =>
      parsePlace({
        title: "x",
        coords: { lat: 40, lon: -7 },
        entries: [
          { id: "e11111", date: "2026-01-01", by: "thiago", photos: [] },
          { id: "e11111", date: "2026-01-02", by: "thiago", photos: [] },
        ],
      }),
    ).toThrow(/duplicate entry id/);
  });
});

describe("labels are normalised so search finds them", () => {
  test("accents, case and spacing collapse to one form", () => {
    expect(normaliseLabels(["Papoila-das-searas", "papoila das searas"], "species")).toEqual([
      "papoila-das-searas",
    ]);
  });

  test("the result is sorted, so a rewrite produces no spurious diff", () => {
    expect(normaliseLabels(["cardo", "acacia", "bardana"], "species")).toEqual([
      "acacia",
      "bardana",
      "cardo",
    ]);
  });
});

describe("derived views", () => {
  test("species is the union of every entry, sorted", () => {
    expect(speciesOf(samplePlace())).toEqual(["cardo", "malmequer-bravo", "papoila-das-searas"]);
  });

  test("entries are kept oldest first", () => {
    const place = samplePlace();
    expect(place.entries.map((e) => e.date)).toEqual(["2026-04-12", "2026-08-31"]);
    expect(firstSeen(place)).toBe("2026-04-12");
    expect(lastSeen(place)).toBe("2026-08-31");
  });

  test("two entries on the same day keep a stable order", () => {
    const entries = [
      { id: "e00002", date: "2026-04-12" },
      { id: "e00001", date: "2026-04-12" },
    ] as Place["entries"];
    expect(sortEntries(entries).map((e) => e.id)).toEqual(["e00001", "e00002"]);
  });
});

describe("round trip", () => {
  test("serialise then parse gives back the same record", () => {
    const place = samplePlace();
    const reparsed = parsePlace(JSON.parse(serialisePlace(place)));
    expect(reparsed).toEqual(place);
  });

  test("serialising twice gives byte-identical output", () => {
    const place = samplePlace();
    const once = serialisePlace(place);
    expect(serialisePlace(parsePlace(JSON.parse(once)))).toBe(once);
  });

  test("hand-written JSON missing the optional fields still parses", () => {
    const place = parsePlace({ title: "Sítio Novo", coords: { lat: 40, lon: -7 } });
    expect(place.slug).toBe("sitio-novo");
    expect(place.entries).toEqual([]);
    expect(place.tags).toEqual([]);
    expect(place.kind).toEqual([]);
  });
});
