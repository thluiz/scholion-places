// routes.test.ts — the API against a real git repository.
//
// The centrepiece is the correction cycle. Everything else in this service
// exists so that these four assertions can hold: record two visits, fix the
// date of one, delete the other, and end up with a file that is coherent, a
// rendering that agrees with it, and a git history that says what happened.
//
// The routes are exercised directly rather than over HTTP. The handlers are
// where the decisions live; the server around them only maps errors to status
// codes and reads a header.

import { $ } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Acl, type Principal } from "./acl";
import { loadConfig, type Config } from "./config";
import { ValidationError } from "./model";
import { PhotoStore, type EncodeResult, type PhotoEncoder } from "./photos";
import { MethodNotAllowedError, matchRoute, type ApiContext, type ApiResult } from "./routes";
import { PlaceIndex } from "./search";
import { localDate } from "./time";
import { ConflictError, NotFoundError, RECORD_FILE, RENDERED_FILE, Vault } from "./vault";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0, 0]);

class FakeEncoder implements PhotoEncoder {
  async encode(input: string, output: string): Promise<EncodeResult> {
    await Bun.write(output, Bun.file(input));
    return { bytes: 999, width: 1600, height: 1200 };
  }
}

let root: string;
let staging: string;
let ctx: ApiContext;
let thiago: Principal;
let reader: Principal;

/** Call a route the way the server would, and hand back status and body. */
async function call(
  method: string,
  path: string,
  options: { body?: Record<string, unknown>; headers?: Record<string, string>; principal?: Principal } = {},
): Promise<ApiResult & { status: number }> {
  const url = new URL(`http://test${path}`);
  const matched = matchRoute(method, url.pathname.replace(/\/+$/, "") || "/");
  if (!matched) throw new NotFoundError(`no route for ${method} ${path}`);

  const result = await matched.route.handle(ctx, {
    principal: options.principal ?? thiago,
    params: matched.params,
    query: url.searchParams,
    headers: new Headers(options.headers ?? {}),
    body: options.body ?? {},
    raw: new Request(url, { method }),
  });
  return { ...result, status: result.status ?? 200 };
}

async function uploadPhoto(): Promise<string> {
  const staged = await ctx.photos.stage(JPEG);
  return staged.id;
}

async function gitLog(): Promise<string[]> {
  const out = await $`git -C ${root} log --format=%s`.quiet().text();
  return out.trim().split("\n");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "places-api-"));
  staging = await mkdtemp(join(tmpdir(), "places-staging-"));

  await $`git -C ${root} init -q -b main`.quiet();
  await mkdir(join(root, "content", "places"), { recursive: true });
  await writeFile(join(root, "README.md"), "content\n");
  await $`git -C ${root} add -A`.quiet();
  await $`git -C ${root} -c user.name=t -c user.email=t@t commit -q -m init`.quiet();

  process.env.VAULT_DIR = root;
  process.env.AUTO_PUSH = "false";
  const config: Config = { ...loadConfig(), stagingDir: staging };

  ctx = {
    config,
    vault: new Vault({ root, autoPush: false }),
    index: new PlaceIndex(),
    photos: new PhotoStore({ dir: staging, maxBytes: 1024 * 1024, ttlHours: 24, encoder: new FakeEncoder() }),
  };

  const acl = new Acl({
    principals: {
      thiago: { apiKey: "k".repeat(32), role: "admin" },
      visitante: { apiKey: "v".repeat(32), role: "read" },
    },
  });
  thiago = acl.authenticate("k".repeat(32));
  reader = acl.authenticate("v".repeat(32));
});

afterEach(async () => {
  await ctx.vault.shutdown();
  ctx.index.close();
  await rm(root, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
});

const FONTE = { title: "Fonte da Pipa", coords: { lat: 40.32611, lon: -7.61389 }, kind: ["flores"] };

describe("creating a place", () => {
  test("writes the record, renders it, and indexes it", async () => {
    const result = await call("POST", "/places", { body: FONTE });

    expect(result.status).toBe(201);
    expect((result.body as any).slug).toBe("fonte-da-pipa");

    const dir = ctx.vault.bundleDir("fonte-da-pipa");
    expect(await Bun.file(join(dir, RECORD_FILE)).exists()).toBe(true);
    expect(await readFile(join(dir, RENDERED_FILE), "utf8")).toContain('title: "Fonte da Pipa"');
    expect(ctx.index.get("fonte-da-pipa")?.title).toBe("Fonte da Pipa");
    expect(await gitLog()).toEqual(["places: novo local Fonte da Pipa", "init"]);
  });

  test("refuses a second place a few metres from the first, and names the neighbour", async () => {
    await call("POST", "/places", { body: FONTE });

    const nearly = { title: "Curva da Fonte", coords: { lat: 40.32615, lon: -7.61392 } };
    await expect(call("POST", "/places", { body: nearly })).rejects.toThrow(ConflictError);
    await expect(call("POST", "/places", { body: nearly })).rejects.toThrow(/fonte-da-pipa/);
  });

  test("force gets past the neighbour check when it really is another place", async () => {
    await call("POST", "/places", { body: FONTE });
    const result = await call("POST", "/places", {
      body: { title: "Curva da Fonte", coords: { lat: 40.32615, lon: -7.61392 }, force: true },
    });
    expect(result.status).toBe(201);
  });

  test("two places genuinely named the same get numbered slugs", async () => {
    await call("POST", "/places", { body: FONTE });
    const second = await call("POST", "/places", {
      body: { ...FONTE, coords: { lat: 41.5, lon: -8.4 } },
    });
    expect((second.body as any).slug).toBe("fonte-da-pipa-2");
  });

  test("without coordinates there is no place", async () => {
    await expect(call("POST", "/places", { body: { title: "Sem sítio" } })).rejects.toThrow(ValidationError);
  });
});

describe("the correction cycle", () => {
  beforeEach(async () => {
    await call("POST", "/places", { body: FONTE });
  });

  test("two visits, a fixed date, and a deletion leave a coherent record", async () => {
    const april = await call("POST", "/places/fonte-da-pipa/entries", {
      body: { date: "2026-04-12", species: ["papoila-das-searas"], note: "campo todo vermelho" },
    });
    const august = await call("POST", "/places/fonte-da-pipa/entries", {
      body: { date: "2026-08-31", species: ["cardo"] },
    });

    const aprilId = (april.body as any).entry.id;
    const augustId = (august.body as any).entry.id;
    expect(aprilId).not.toBe(augustId);

    // The date was wrong: it was the 14th, not the 12th.
    const fixed = await call("PATCH", `/places/fonte-da-pipa/entries/${aprilId}`, {
      body: { date: "2026-04-14" },
    });
    expect((fixed.body as any).entry.date).toBe("2026-04-14");
    // Correcting one field leaves the others alone.
    expect((fixed.body as any).entry.note).toBe("campo todo vermelho");
    expect((fixed.body as any).entry.species).toEqual(["papoila-das-searas"]);

    // The August visit was never ours.
    await call("DELETE", `/places/fonte-da-pipa/entries/${augustId}`);

    const { place } = await ctx.vault.read("fonte-da-pipa");
    expect(place.entries.map((entry) => entry.date)).toEqual(["2026-04-14"]);

    // The rendering agrees, and the aggregate species followed the deletion.
    const rendered = await readFile(join(ctx.vault.bundleDir("fonte-da-pipa"), RENDERED_FILE), "utf8");
    expect(rendered).toContain("## 2026-04-14 — Papoila das searas");
    expect(rendered).not.toContain("cardo");
    expect(rendered).toContain('species: ["papoila-das-searas"]');

    // And the history says what happened, in order.
    expect(await gitLog()).toEqual([
      `places: remove entrada ${augustId} de fonte-da-pipa`,
      `places: corrige entrada ${aprilId} em fonte-da-pipa`,
      "places: nova entrada em fonte-da-pipa",
      "places: nova entrada em fonte-da-pipa",
      "places: novo local Fonte da Pipa",
      "init",
    ]);
  });

  test("an entry defaults to today, to a sighting, and to whoever asked", async () => {
    const result = await call("POST", "/places/fonte-da-pipa/entries", { body: { species: ["cardo"] } });
    const entry = (result.body as any).entry;

    expect(entry.type).toBe("sighting");
    expect(entry.by).toBe("thiago");
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("who recorded a visit does not change when somebody else corrects it", async () => {
    const created = await call("POST", "/places/fonte-da-pipa/entries", { body: { species: ["cardo"] } });
    const id = (created.body as any).entry.id;

    const patched = await call("PATCH", `/places/fonte-da-pipa/entries/${id}`, {
      body: { note: "corrigido" },
      principal: { ...thiago, name: "thilia" } as Principal,
    });
    expect((patched.body as any).entry.by).toBe("thiago");
  });

  test("an entry id that is not there", async () => {
    await expect(
      call("PATCH", "/places/fonte-da-pipa/entries/e00000", { body: { note: "x" } }),
    ).rejects.toThrow(NotFoundError);
  });

  test("a meal is recorded with its dish and rating", async () => {
    const result = await call("POST", "/places/fonte-da-pipa/entries", {
      body: { type: "visit", date: "2026-05-03", dish: "arroz de cabidela", rating: 4 },
    });
    expect((result.body as any).entry.rating).toBe(4);

    const rendered = await readFile(join(ctx.vault.bundleDir("fonte-da-pipa"), RENDERED_FILE), "utf8");
    expect(rendered).toContain("## 2026-05-03 — arroz de cabidela");
    expect(rendered).toContain("Nota: ★★★★☆");
  });
});

describe("concurrent editing", () => {
  test("a stale If-Match is refused and nothing is written", async () => {
    const created = await call("POST", "/places", { body: FONTE });
    const staleEtag = (created.body as any).etag;

    await call("PATCH", "/places/fonte-da-pipa", { body: { summary: "editado por outro" } });

    await expect(
      call("PATCH", "/places/fonte-da-pipa", {
        body: { summary: "sobrescrito" },
        headers: { "If-Match": `"${staleEtag}"` },
      }),
    ).rejects.toThrow(ConflictError);

    const { place } = await ctx.vault.read("fonte-da-pipa");
    expect(place.summary).toBe("editado por outro");
  });

  test("the current If-Match goes through", async () => {
    const created = await call("POST", "/places", { body: FONTE });
    const result = await call("PATCH", "/places/fonte-da-pipa", {
      body: { summary: "com etag válido" },
      headers: { "If-Match": `"${(created.body as any).etag}"` },
    });
    expect((result.body as any).summary).toBe("com etag válido");
  });

  test("a delete is guarded the same way", async () => {
    const created = await call("POST", "/places", { body: FONTE });
    await call("PATCH", "/places/fonte-da-pipa", { body: { summary: "mudou" } });

    await expect(
      call("DELETE", "/places/fonte-da-pipa", { headers: { "If-Match": `"${(created.body as any).etag}"` } }),
    ).rejects.toThrow(ConflictError);
    expect(await ctx.vault.exists("fonte-da-pipa")).toBe(true);
  });
});

describe("photos", () => {
  beforeEach(async () => {
    await call("POST", "/places", { body: FONTE });
  });

  test("staged, then attached, named after the visit", async () => {
    const id = await uploadPhoto();
    const created = await call("POST", "/places/fonte-da-pipa/entries", {
      body: { date: "2026-04-12", species: ["papoila-das-searas"], photos: [id] },
    });

    const entry = (created.body as any).entry;
    expect(entry.photos).toHaveLength(1);
    expect(entry.photos[0].file).toBe("2026-04-12-papoila-das-searas.jpg");

    const path = join(ctx.vault.bundleDir("fonte-da-pipa"), entry.photos[0].file);
    expect(await Bun.file(path).exists()).toBe(true);

    const tracked = await $`git -C ${root} ls-files content/places/fonte-da-pipa`.quiet().text();
    expect(tracked).toContain("2026-04-12-papoila-das-searas.jpg");
  });

  test("several photos on one visit are numbered, not overwritten", async () => {
    const first = await uploadPhoto();
    const second = await uploadPhoto();
    const created = await call("POST", "/places/fonte-da-pipa/entries", {
      body: { date: "2026-04-12", species: ["cardo"], photos: [first, second] },
    });

    const files = (created.body as any).entry.photos.map((photo: any) => photo.file);
    expect(files).toEqual(["2026-04-12-cardo.jpg", "2026-04-12-cardo-2.jpg"]);
  });

  test("the foto: prefix a media pipeline hands over is accepted", async () => {
    const id = await uploadPhoto();
    const created = await call("POST", "/places/fonte-da-pipa/entries", {
      body: { species: ["cardo"], photos: [`foto:${id}`] },
    });
    expect((created.body as any).entry.photos).toHaveLength(1);
  });

  test("attaching to an existing visit, and detaching again", async () => {
    const created = await call("POST", "/places/fonte-da-pipa/entries", { body: { species: ["cardo"] } });
    const entryId = (created.body as any).entry.id;

    const attached = await call("POST", `/places/fonte-da-pipa/entries/${entryId}/photos`, {
      body: { photos: [await uploadPhoto()] },
    });
    const photo = (attached.body as any).entry.photos[0];

    await call("PATCH", `/places/fonte-da-pipa/entries/${entryId}/photos/${photo.id}`, {
      body: { caption: "de perto" },
    });
    const withCaption = await ctx.vault.read("fonte-da-pipa");
    expect(withCaption.place.entries[0].photos[0].caption).toBe("de perto");

    await call("DELETE", `/places/fonte-da-pipa/entries/${entryId}/photos/${photo.id}`);
    const after = await ctx.vault.read("fonte-da-pipa");
    expect(after.place.entries[0].photos).toEqual([]);
    expect(await Bun.file(join(ctx.vault.bundleDir("fonte-da-pipa"), photo.file)).exists()).toBe(false);
  });

  test("correcting the visit renames its photos to match", async () => {
    // Photos are attached the moment they arrive, which is before the details
    // are right: the date still says today and nobody has named the flower yet.
    const created = await call("POST", "/places/fonte-da-pipa/entries", {
      body: { photos: [await uploadPhoto(), await uploadPhoto()] },
    });
    const entry = (created.body as any).entry;
    const hoje = new Date().toLocaleDateString("en-CA");
    expect(entry.photos.map((p: any) => p.file)).toEqual([`${hoje}-foto.jpg`, `${hoje}-foto-2.jpg`]);

    const fixed = await call("PATCH", `/places/fonte-da-pipa/entries/${entry.id}`, {
      body: { date: "2026-08-31", species: ["hortênsia"] },
    });

    const files = (fixed.body as any).entry.photos.map((p: any) => p.file);
    expect(files).toEqual(["2026-08-31-hortensia.jpg", "2026-08-31-hortensia-2.jpg"]);

    // The bytes moved with the names, and nothing stayed behind.
    for (const file of files) {
      expect(await Bun.file(join(ctx.vault.bundleDir("fonte-da-pipa"), file)).exists()).toBe(true);
    }
    expect(await Bun.file(join(ctx.vault.bundleDir("fonte-da-pipa"), `${hoje}-foto.jpg`)).exists()).toBe(false);

    const tracked = await $`git -C ${root} ls-files content/places/fonte-da-pipa`.quiet().text();
    expect(tracked).toContain("2026-08-31-hortensia.jpg");
    expect(tracked).not.toContain(`${hoje}-foto.jpg`);
  });

  test("a meal names its photos after the dish when no species is given", async () => {
    const created = await call("POST", "/places/fonte-da-pipa/entries", {
      body: { type: "visit", date: "2026-05-03", dish: "Arroz de cabidela", photos: [await uploadPhoto()] },
    });
    expect((created.body as any).entry.photos[0].file).toBe("2026-05-03-arroz-de-cabidela.jpg");
  });

  test("a correction that changes nothing leaves the filenames alone", async () => {
    const created = await call("POST", "/places/fonte-da-pipa/entries", {
      body: { date: "2026-04-12", species: ["cardo"], photos: [await uploadPhoto()] },
    });
    const before = (created.body as any).entry.photos[0].file;

    const after = await call("PATCH", `/places/fonte-da-pipa/entries/${(created.body as any).entry.id}`, {
      body: { note: "só a nota mudou" },
    });
    expect((after.body as any).entry.photos[0].file).toBe(before);
  });

  test("deleting a visit takes its photos with it", async () => {
    const created = await call("POST", "/places/fonte-da-pipa/entries", {
      body: { species: ["cardo"], photos: [await uploadPhoto()] },
    });
    const entry = (created.body as any).entry;

    await call("DELETE", `/places/fonte-da-pipa/entries/${entry.id}`);
    expect(await Bun.file(join(ctx.vault.bundleDir("fonte-da-pipa"), entry.photos[0].file)).exists()).toBe(false);
  });

  test("a photo id that expired", async () => {
    await expect(
      call("POST", "/places/fonte-da-pipa/entries", { body: { photos: ["aaaaaaaaaaaa"] } }),
    ).rejects.toThrow(/not staged/);
  });
});

describe("searching", () => {
  beforeEach(async () => {
    await call("POST", "/places", { body: FONTE });
    await call("POST", "/places/fonte-da-pipa/entries", {
      body: { date: "2026-04-12", species: ["papoila-das-searas"], note: "campo todo vermelho" },
    });
    await call("POST", "/places", {
      body: { title: "Tasca do Manel", coords: { lat: 41.5, lon: -8.4 }, kind: ["restaurante"] },
    });
  });

  test("by month, which is the question this collection exists for", async () => {
    const april = await call("GET", "/places?month=4");
    expect((april.body as any).results.map((hit: any) => hit.slug)).toEqual(["fonte-da-pipa"]);
  });

  test("by proximity, with the distance in the answer", async () => {
    const near = await call("GET", "/places?near=40.32611,-7.61389&radius_km=1");
    const results = (near.body as any).results;
    expect(results).toHaveLength(1);
    expect(results[0].distanceM).toBe(0);
  });

  test("by free text, accents optional", async () => {
    const found = await call("GET", "/places?q=vermelho");
    expect((found.body as any).results.map((hit: any) => hit.slug)).toEqual(["fonte-da-pipa"]);
  });

  test("species and tags are listed with counts", async () => {
    const species = await call("GET", "/species");
    expect((species.body as any).species).toEqual([{ label: "papoila-das-searas", places: 1 }]);
  });

  test("a month outside the calendar is refused", async () => {
    await expect(call("GET", "/places?month=13")).rejects.toThrow(ValidationError);
  });

  test("by when the record was created or changed, not when it was visited", async () => {
    const today = localDate();
    const tomorrow = localDate(new Date(Date.now() + 24 * 60 * 60 * 1000));

    const found = await call("GET", `/places?updated_since=${today}`);
    expect((found.body as any).results.map((hit: any) => hit.slug).sort()).toEqual([
      "fonte-da-pipa",
      "tasca-do-manel",
    ]);

    const none = await call("GET", `/places?updated_since=${tomorrow}`);
    expect((none.body as any).total).toBe(0);
  });

  test("an invalid updated_since is refused", async () => {
    await expect(call("GET", "/places?updated_since=not-a-date")).rejects.toThrow(ValidationError);
  });
});

describe("re-rendering touches only what is published", () => {
  test("a stale rendering is rewritten and the record is untouched", async () => {
    await call("POST", "/places", { body: FONTE });
    const recordPath = join(ctx.vault.bundleDir("fonte-da-pipa"), RECORD_FILE);
    const before = await readFile(recordPath, "utf8");

    // Simulate the state a template change leaves behind: the published file
    // committed as it used to be rendered. Merely editing the working copy
    // would not do — re-rendering would put back exactly what git already has.
    await writeFile(join(ctx.vault.bundleDir("fonte-da-pipa"), RENDERED_FILE), "desactualizado\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} -c user.name=t -c user.email=t@t commit -q -m "layout antigo"`.quiet();

    const result = await call("POST", "/render?all=true");
    expect((result.body as any).changed).toEqual(["fonte-da-pipa"]);
    expect((result.body as any).committed).toBe(true);
    expect(await readFile(recordPath, "utf8")).toBe(before);

    // The commit that a template change produces mentions only rendered files.
    const changed = await $`git -C ${root} show --name-only --format= HEAD`.quiet().text();
    expect(changed).toContain(RENDERED_FILE);
    expect(changed).not.toContain(RECORD_FILE);
  });

  test("re-rendering an unchanged collection commits nothing", async () => {
    await call("POST", "/places", { body: FONTE });
    const result = await call("POST", "/render?all=true");
    expect((result.body as any).changed).toEqual([]);
    expect((result.body as any).committed).toBe(false);
  });
});

describe("renaming", () => {
  test("moves the bundle and keeps the title", async () => {
    await call("POST", "/places", { body: FONTE });
    await call("POST", "/places/fonte-da-pipa/rename", { body: { slug: "fonte-da-pipa-norte" } });

    expect(await ctx.vault.exists("fonte-da-pipa")).toBe(false);
    expect(ctx.index.get("fonte-da-pipa")).toBeNull();
    expect(ctx.index.get("fonte-da-pipa-norte")?.title).toBe("Fonte da Pipa");
  });
});

describe("the router", () => {
  test("an unknown path is not found", () => {
    expect(matchRoute("GET", "/nada")).toBeNull();
  });

  test("a known path with the wrong method says so", () => {
    expect(() => matchRoute("PUT", "/places")).toThrow(MethodNotAllowedError);
  });

  test("a slug that would escape the content directory", async () => {
    await expect(call("GET", "/places/..%2F..%2Fetc")).rejects.toThrow(ValidationError);
  });
});

describe("what a caller may reach", () => {
  test("a read-only principal is not shown the operations it cannot use", () => {
    expect(reader.operations.has("places.search")).toBe(true);
    expect(reader.operations.has("place.create")).toBe(false);
    expect(reader.operations.has("place.delete")).toBe(false);
  });

  test("an admin reaches the destructive operations, because git remembers", () => {
    expect(thiago.operations.has("place.delete")).toBe(true);
    expect(thiago.operations.has("admin.render")).toBe(true);
  });
});
