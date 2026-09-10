// mcp.test.ts
//
// The property worth testing is not that the tools work — the routes are
// already covered — but that they are the *same* routes. A tool that quietly
// grew its own validation, or that a principal could reach without holding the
// operation behind it, is the failure this file is here to catch.

import { $ } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Acl, OPERATIONS, type Principal } from "./acl";
import { loadConfig, type Config } from "./config";
import { MCP_TOOLS, callTool, toolsFor } from "./mcp";
import { ValidationError } from "./model";
import { PhotoStore, type EncodeResult, type PhotoEncoder } from "./photos";
import { matchRoute, type ApiContext } from "./routes";
import { PlaceIndex } from "./search";
import { ConflictError, NotFoundError, Vault } from "./vault";

class FakeEncoder implements PhotoEncoder {
  async encode(input: string, output: string): Promise<EncodeResult> {
    await Bun.write(output, Bun.file(input));
    return { bytes: 1, width: 10, height: 10 };
  }
}

let root: string;
let staging: string;
let ctx: ApiContext;
let admin: Principal;
let writer: Principal;
let reader: Principal;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "places-mcp-"));
  staging = await mkdtemp(join(tmpdir(), "places-mcp-staging-"));

  await $`git -C ${root} init -q -b main`.quiet();
  await mkdir(join(root, "content", "places"), { recursive: true });
  await writeFile(join(root, "README.md"), "c\n");
  await $`git -C ${root} add -A`.quiet();
  await $`git -C ${root} -c user.name=t -c user.email=t@t commit -q -m init`.quiet();

  process.env.VAULT_DIR = root;
  process.env.AUTO_PUSH = "false";
  const config: Config = { ...loadConfig(), stagingDir: staging };

  ctx = {
    config,
    vault: new Vault({ root, autoPush: false }),
    index: new PlaceIndex(),
    photos: new PhotoStore({ dir: staging, maxBytes: 1024, ttlHours: 24, encoder: new FakeEncoder() }),
  };

  const acl = new Acl({
    principals: {
      chefe: { apiKey: "a".repeat(32), role: "admin" },
      registador: { apiKey: "b".repeat(32), role: "write" },
      visitante: { apiKey: "c".repeat(32), role: "read" },
    },
  });
  admin = acl.authenticate("a".repeat(32));
  writer = acl.authenticate("b".repeat(32));
  reader = acl.authenticate("c".repeat(32));
});

afterEach(async () => {
  await ctx.vault.shutdown();
  ctx.index.close();
  await rm(root, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
});

describe("the tools are a view of the API, not a second one", () => {
  test("every tool resolves to a real route", () => {
    for (const tool of MCP_TOOLS) {
      const sample: Record<string, unknown> = {
        slug: "algum-sitio",
        entry_id: "e00001",
        lat: 40,
        lon: -7,
        title: "x",
      };
      const { method, path } = tool.request(sample);
      const url = new URL(`http://mcp${path}`);
      const matched = matchRoute(method, url.pathname);
      expect(matched).not.toBeNull();
      expect(matched!.route.operation).toBe(tool.operation);
    }
  });

  test("every declared operation exists", () => {
    const known = new Set<string>(OPERATIONS);
    for (const tool of MCP_TOOLS) expect(known.has(tool.operation)).toBe(true);
  });

  test("no tool reaches an operation a plain 'write' principal lacks", () => {
    // The surface offered to a bot must not be a way around the role split.
    for (const tool of toolsFor(writer)) {
      expect(writer.operations.has(tool.operation)).toBe(true);
    }
  });
});

describe("what each principal is shown", () => {
  test("a reader sees only the questions, never the writes", () => {
    const names = toolsFor(reader).map((tool) => tool.name).sort();
    expect(names).toEqual(["place_get", "places_list_species", "places_nearby", "places_search"]);
  });

  test("a writer additionally sees how to record and correct", () => {
    const names = toolsFor(writer).map((tool) => tool.name);
    expect(names).toContain("place_create");
    expect(names).toContain("place_add_entry");
    expect(names).toContain("place_update_entry");
  });

  test("a denied operation is not listed, and is refused if named anyway", async () => {
    const acl = new Acl({
      principals: { limitado: { apiKey: "d".repeat(32), role: "write", deny: ["entry.create"] } },
    });
    const limited = acl.authenticate("d".repeat(32));

    expect(toolsFor(limited).map((tool) => tool.name)).not.toContain("place_add_entry");
    await expect(callTool(ctx, limited, "place_add_entry", { slug: "x" })).rejects.toThrow(/may not/);
  });

  test("a tool nobody defined", async () => {
    await expect(callTool(ctx, admin, "place_destroy", {})).rejects.toThrow(/Unknown tool/);
  });
});

describe("calling through", () => {
  async function create(): Promise<string> {
    const created = (await callTool(ctx, admin, "place_create", {
      title: "Fonte da Pipa",
      lat: 40.32611,
      lon: -7.61389,
      kind: ["flores"],
    })) as { slug: string };
    return created.slug;
  }

  test("a place created by tool is on disk and in the index", async () => {
    const slug = await create();
    expect(slug).toBe("fonte-da-pipa");
    expect(await ctx.vault.exists(slug)).toBe(true);
    expect(ctx.index.get(slug)?.title).toBe("Fonte da Pipa");
  });

  test("the neighbour refusal reaches the model as a refusal, with the neighbour named", async () => {
    await create();
    await expect(
      callTool(ctx, admin, "place_create", { title: "Outra coisa", lat: 40.32615, lon: -7.61392 }),
    ).rejects.toThrow(ConflictError);
  });

  test("the whole cycle: find, record, correct", async () => {
    await create();

    const nearby = (await callTool(ctx, admin, "places_nearby", { lat: 40.32611, lon: -7.61389 })) as {
      results: { slug: string; distanceM: number }[];
    };
    expect(nearby.results[0].slug).toBe("fonte-da-pipa");
    expect(nearby.results[0].distanceM).toBe(0);

    const added = (await callTool(ctx, admin, "place_add_entry", {
      slug: "fonte-da-pipa",
      date: "2026-04-12",
      species: ["Papoila-das-searas"],
      note: "campo todo vermelho",
    })) as { entry: { id: string; species: string[] } };
    expect(added.entry.species).toEqual(["papoila-das-searas"]);

    const corrected = (await callTool(ctx, admin, "place_update_entry", {
      slug: "fonte-da-pipa",
      entry_id: added.entry.id,
      date: "2026-04-14",
    })) as { entry: { date: string; note: string } };
    expect(corrected.entry.date).toBe("2026-04-14");
    expect(corrected.entry.note).toBe("campo todo vermelho");
  });

  test("search by month arrives as a real filter, not as text", async () => {
    await create();
    await callTool(ctx, admin, "place_add_entry", { slug: "fonte-da-pipa", date: "2026-04-12", species: ["cardo"] });

    const april = (await callTool(ctx, admin, "places_search", { month: 4 })) as { total: number };
    const august = (await callTool(ctx, admin, "places_search", { month: 8 })) as { total: number };
    expect(april.total).toBe(1);
    expect(august.total).toBe(0);
  });

  test("validation is the route's, so a bad argument fails the same way", async () => {
    await expect(
      callTool(ctx, admin, "place_create", { title: "Sem sítio", lat: 999, lon: 0 }),
    ).rejects.toThrow(ValidationError);
  });

  test("a place that is not there", async () => {
    await expect(callTool(ctx, admin, "place_get", { slug: "nao-existe" })).rejects.toThrow(NotFoundError);
  });

  test("a photo id the model invented is refused rather than silently ignored", async () => {
    await create();
    await expect(
      callTool(ctx, admin, "place_add_entry", { slug: "fonte-da-pipa", photos: ["foto:aaaaaaaaaaaa"] }),
    ).rejects.toThrow(/not staged/);
  });
});

describe("the schemas the model reads", () => {
  test("every tool documents every argument it accepts", () => {
    for (const tool of MCP_TOOLS) {
      const properties = (tool.inputSchema as { properties: Record<string, { description?: string }> })
        .properties;
      for (const [name, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${name} has no description`).toBeTruthy();
      }
    }
  });

  test("the photo argument warns against inventing ids", () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "place_add_entry")!;
    const photos = (tool.inputSchema as any).properties.photos.description as string;
    expect(photos).toContain("no photo arrived");
  });
});
