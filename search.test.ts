// search.test.ts
//
// The question this collection exists to answer is "what flowers here, in
// April?" — so the tests that matter are the month filter, the distance sort,
// and the accent folding. A Portuguese collection where "acafrao" misses
// "açafrão" is a collection nobody searches twice.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { parsePlace, type Place } from "./model";
import { PlaceIndex, syncIndex, toMatchExpression } from "./search";
import type { StoredPlace } from "./vault";

let index: PlaceIndex;

function stored(input: Record<string, unknown>, mtimeMs = 1): StoredPlace {
  const place = parsePlace(input) as Place;
  return { place, etag: `etag-${place.slug}`, mtimeMs };
}

const FONTE = {
  title: "Fonte da Pipa",
  kind: ["flores"],
  tags: ["Serra da Estrela"],
  summary: "Campo aberto virado a sul.",
  coords: { lat: 40.32611, lon: -7.61389 },
  body: "Estaciona-se na berma larga.",
  entries: [
    {
      id: "e00001",
      date: "2026-04-12",
      type: "sighting",
      by: "thiago",
      species: ["papoila-das-searas"],
      note: "campo todo vermelho",
      photos: [{ id: "p00001", file: "a.jpg" }],
    },
    {
      id: "e00002",
      date: "2026-08-31",
      type: "sighting",
      by: "thilia",
      species: ["cardo"],
      photos: [],
    },
  ],
};

const AZENHA = {
  title: "Azenha Velha",
  kind: ["flores"],
  tags: ["serra-da-estrela"],
  // Roughly 600 m from Fonte da Pipa.
  coords: { lat: 40.3315, lon: -7.61389 },
  entries: [
    {
      id: "e00003",
      date: "2026-04-20",
      type: "sighting",
      by: "thiago",
      species: ["açafrão-bravo"],
      note: "junto ao muro",
      photos: [],
    },
  ],
};

const TASCA = {
  title: "Tasca do Manel",
  kind: ["restaurante"],
  coords: { lat: 41.5, lon: -8.4 },
  entries: [
    {
      id: "e00004",
      date: "2026-05-03",
      type: "visit",
      by: "thiago",
      dish: "arroz de cabidela",
      rating: 4,
      note: "vale a pena a espera",
      photos: [],
    },
  ],
};

beforeEach(() => {
  index = new PlaceIndex();
  index.rebuild([stored(FONTE), stored(AZENHA), stored(TASCA)]);
});

afterEach(() => index.close());

describe("full text", () => {
  test("finds a place by a word in its prose", () => {
    expect(index.search({ q: "berma" }).results.map((h) => h.slug)).toEqual(["fonte-da-pipa"]);
  });

  test("finds a place by a note written on a visit", () => {
    expect(index.search({ q: "cabidela" }).results.map((h) => h.slug)).toEqual(["tasca-do-manel"]);
  });

  test("accents are optional in both directions", () => {
    const withAccent = index.search({ q: "açafrão" }).results.map((h) => h.slug);
    const without = index.search({ q: "acafrao" }).results.map((h) => h.slug);
    expect(withAccent).toEqual(["azenha-velha"]);
    expect(without).toEqual(["azenha-velha"]);
  });

  test("a hyphenated species is found by one of its words", () => {
    expect(index.search({ q: "papoila" }).results.map((h) => h.slug)).toEqual(["fonte-da-pipa"]);
    expect(index.search({ q: "searas" }).results.map((h) => h.slug)).toEqual(["fonte-da-pipa"]);
  });

  test("punctuation in the query is not read as query syntax", () => {
    // Would be an FTS5 syntax error unquoted.
    expect(() => index.search({ q: 'papoila-das "searas' })).not.toThrow();
  });

  test("nonsense matches nothing rather than everything", () => {
    expect(index.search({ q: "xilofone" }).total).toBe(0);
  });
});

describe("filters", () => {
  test("by month, across every year — the seasonal question", () => {
    const april = index.search({ month: 4 }).results.map((h) => h.slug);
    expect(april.sort()).toEqual(["azenha-velha", "fonte-da-pipa"]);

    expect(index.search({ month: 8 }).results.map((h) => h.slug)).toEqual(["fonte-da-pipa"]);
    expect(index.search({ month: 12 }).total).toBe(0);
  });

  test("by kind", () => {
    expect(index.search({ kind: "restaurante" }).results.map((h) => h.slug)).toEqual([
      "tasca-do-manel",
    ]);
  });

  test("by species, normalised the same way on both sides", () => {
    expect(index.search({ species: "acafrao-bravo" }).results.map((h) => h.slug)).toEqual([
      "azenha-velha",
    ]);
  });

  test("by tag, whatever case it was typed in", () => {
    expect(index.search({ tag: "serra-da-estrela" }).total).toBe(2);
  });

  test("by date range", () => {
    expect(index.search({ since: "2026-08-01" }).results.map((h) => h.slug)).toEqual([
      "fonte-da-pipa",
    ]);
    expect(index.search({ until: "2026-04-15" }).results.map((h) => h.slug)).toEqual([
      "fonte-da-pipa",
    ]);
  });

  test("filters compose: flowers, in April, near here", () => {
    const result = index.search({
      month: 4,
      kind: "flores",
      near: { lat: 40.32611, lon: -7.61389 },
      radiusKm: 1,
    });
    expect(result.results.map((h) => h.slug)).toEqual(["fonte-da-pipa", "azenha-velha"]);
  });
});

describe("geography", () => {
  test("nearby is ordered by distance and carries it in the answer", () => {
    const result = index.nearby({ lat: 40.32611, lon: -7.61389 }, 1);
    expect(result.results.map((h) => h.slug)).toEqual(["fonte-da-pipa", "azenha-velha"]);
    expect(result.results[0].distanceM).toBe(0);
    expect(result.results[1].distanceM).toBeGreaterThan(500);
    expect(result.results[1].distanceM).toBeLessThan(700);
  });

  test("the radius actually excludes — a box alone would not", () => {
    expect(index.nearby({ lat: 40.32611, lon: -7.61389 }, 0.3).results.map((h) => h.slug)).toEqual([
      "fonte-da-pipa",
    ]);
  });

  test("somewhere else entirely finds nothing", () => {
    expect(index.nearby({ lat: 38.7, lon: -9.14 }, 5).total).toBe(0);
  });
});

describe("labels", () => {
  test("species are listed with how many places have them", () => {
    expect(index.listSpecies()).toEqual([
      { label: "acafrao-bravo", places: 1 },
      { label: "cardo", places: 1 },
      { label: "papoila-das-searas", places: 1 },
    ]);
  });

  test("tags collapse to one entry however they were typed", () => {
    expect(index.listTags()).toEqual([{ label: "serra-da-estrela", places: 2 }]);
  });
});

describe("the index is disposable", () => {
  test("a full rebuild equals what incremental upserts produced", () => {
    const incremental = new PlaceIndex();
    incremental.upsert(stored(FONTE));
    incremental.upsert(stored(AZENHA));
    incremental.upsert(stored(TASCA));

    const fromRebuild = index.search({}).results;
    const fromUpserts = incremental.search({}).results;
    expect(fromUpserts).toEqual(fromRebuild);
    incremental.close();
  });

  test("upserting the same place twice does not duplicate it", () => {
    index.upsert(stored(FONTE));
    index.upsert(stored(FONTE));
    expect(index.count()).toBe(3);
    expect(index.search({ q: "berma" }).total).toBe(1);
  });

  test("forget removes the place from the full text index too", () => {
    index.forget("fonte-da-pipa");
    expect(index.get("fonte-da-pipa")).toBeNull();
    expect(index.search({ q: "berma" }).total).toBe(0);
  });
});

describe("syncIndex follows what is on disk", () => {
  test("adds, updates and removes by comparing mtimes", async () => {
    const fresh = new PlaceIndex();

    let disk = [stored(FONTE, 100), stored(AZENHA, 100)];
    expect(await syncIndex(fresh, async () => disk)).toEqual({ added: 2, updated: 0, removed: 0 });

    // Nothing moved: nothing is re-read into the index.
    expect(await syncIndex(fresh, async () => disk)).toEqual({ added: 0, updated: 0, removed: 0 });

    // Somebody edited the file by hand, so its mtime moved.
    disk = [stored({ ...FONTE, summary: "editado à mão" }, 200), stored(AZENHA, 100)];
    expect(await syncIndex(fresh, async () => disk)).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(fresh.get("fonte-da-pipa")?.summary).toBe("editado à mão");

    disk = [stored(AZENHA, 100)];
    expect(await syncIndex(fresh, async () => disk)).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(fresh.get("fonte-da-pipa")).toBeNull();

    fresh.close();
  });
});

describe("toMatchExpression", () => {
  test("quotes every term and completes the last one", () => {
    expect(toMatchExpression("papoila searas")).toBe('"papoila" AND "searas"*');
  });

  test("empty input asks for nothing", () => {
    expect(toMatchExpression("   ")).toBeNull();
  });
});
