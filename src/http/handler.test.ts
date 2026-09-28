// handler.test.ts — the request as the server sees it: header in, status out.
//
// routes.test.ts calls the handlers directly. What it cannot see is what sits
// around them — who the caller is, which status an error becomes, what the
// write budget allows — and that is what these tests are for.

import { $ } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../config";
import { Logger } from "../logger";
import { WriteBudget } from "../security/budget";
import { LiveAcl } from "../security/live-acl";
import { PhotoStore, type EncodeResult, type PhotoEncoder } from "../storage/photos";
import { PlaceIndex } from "../storage/search";
import { Vault } from "../storage/vault";
import type { ApiContext } from "./api";
import { createHandler } from "./handler";

const ADMIN_KEY = "k".repeat(32);
const READER_KEY = "v".repeat(32);

class FakeEncoder implements PhotoEncoder {
  async encode(input: string, output: string): Promise<EncodeResult> {
    await Bun.write(output, Bun.file(input));
    return { bytes: 1, width: 1, height: 1 };
  }
}

let root: string;
let scratch: string;
let ctx: ApiContext;
let handle: (request: Request) => Promise<Response>;

function send(method: string, path: string, options: { key?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.key) headers["x-api-key"] = options.key;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return handle(
    new Request(`http://test${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "places-handler-"));
  scratch = await mkdtemp(join(tmpdir(), "places-handler-scratch-"));

  await $`git -C ${root} init -q -b main`.quiet();
  await mkdir(join(root, "content", "places"), { recursive: true });
  await writeFile(join(root, "README.md"), "content\n");
  await $`git -C ${root} add -A`.quiet();
  await $`git -C ${root} -c user.name=t -c user.email=t@t commit -q -m init`.quiet();

  const aclPath = join(scratch, "acl.json");
  await writeFile(
    aclPath,
    JSON.stringify({
      principals: {
        thiago: { apiKey: ADMIN_KEY, role: "admin" },
        visitante: { apiKey: READER_KEY, role: "read" },
      },
    }),
  );

  process.env.VAULT_DIR = root;
  process.env.AUTO_PUSH = "false";
  const config = { ...loadConfig(), stagingDir: join(scratch, "staging") };

  ctx = {
    config,
    vault: new Vault({ root, autoPush: false }),
    index: new PlaceIndex(),
    photos: new PhotoStore({ dir: config.stagingDir, maxBytes: 1024, ttlHours: 24, encoder: new FakeEncoder() }),
  };

  handle = createHandler({
    service: "scholion-places",
    version: "test",
    context: ctx,
    acl: await LiveAcl.open(aclPath, "test"),
    // One write a minute, so the second one shows what the budget does.
    budget: new WriteBudget(1, 100),
    logger: new Logger(join(scratch, "logs"), 1),
  });
});

afterEach(async () => {
  await ctx.vault.shutdown();
  ctx.index.close();
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe("the handler", () => {
  test("health answers without a key", async () => {
    const response = await send("GET", "/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; places: number; version: string };
    expect(body.ok).toBe(true);
    expect(body.places).toBe(0);
    expect(body.version).toBe("test");
  });

  test("everything else needs a key it recognises", async () => {
    expect((await send("GET", "/places")).status).toBe(401);
    expect((await send("GET", "/places", { key: "x".repeat(32) })).status).toBe(401);
  });

  test("me lists only what the caller may do", async () => {
    const response = await send("GET", "/me", { key: READER_KEY });
    const body = (await response.json()) as { principal: string; operations: string[] };
    expect(body.principal).toBe("visitante");
    expect(body.operations).toContain("places.search");
    expect(body.operations).not.toContain("place.create");
  });

  test("a read-only key is refused a write", async () => {
    const response = await send("POST", "/places", {
      key: READER_KEY,
      body: { title: "Fonte da Pipa", coords: { lat: 40.32611, lon: -7.61389 } },
    });
    expect(response.status).toBe(403);
  });

  test("unknown paths are 404, known paths with the wrong method 405", async () => {
    expect((await send("GET", "/nowhere", { key: ADMIN_KEY })).status).toBe(404);
    expect((await send("PUT", "/places", { key: ADMIN_KEY })).status).toBe(405);
  });

  test("a body that is not a JSON object is a 400, not a 500", async () => {
    const response = await handle(
      new Request("http://test/places", {
        method: "POST",
        headers: { "x-api-key": ADMIN_KEY, "content-type": "application/json" },
        body: "[1, 2]",
      }),
    );
    expect(response.status).toBe(400);
  });

  test("a write goes through, and the budget stops the next one", async () => {
    const created = await send("POST", "/places", {
      key: ADMIN_KEY,
      body: { title: "Fonte da Pipa", kind: ["flores"], coords: { lat: 40.32611, lon: -7.61389 } },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe("/places/fonte-da-pipa");

    const second = await send("POST", "/places", {
      key: ADMIN_KEY,
      body: { title: "Outra", kind: ["flores"], coords: { lat: 41, lon: -8 } },
    });
    expect(second.status).toBe(429);
  });
});
