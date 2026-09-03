// photos.test.ts
//
// ffmpeg is not installed on the machine these were written on, so the encoder
// goes in through the constructor. That is not a concession to testing: it is
// the seam that keeps the one module which shells out to a binary from being
// the module that also decides what a photo is called and when it expires.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ValidationError } from "./model";
import {
  PhotoNotFoundError,
  PhotoStore,
  photoFilename,
  sniffImageType,
  type EncodeResult,
  type PhotoEncoder,
} from "./photos";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const NOT_AN_IMAGE = new TextEncoder().encode("<?php echo 'hello'; ?>      ");

/** Stands in for ffmpeg: copies the input and reports a plausible result. */
class FakeEncoder implements PhotoEncoder {
  calls: { input: string; output: string }[] = [];
  shouldFail = false;

  async encode(input: string, output: string): Promise<EncodeResult> {
    this.calls.push({ input, output });
    if (this.shouldFail) throw new ValidationError("could not read that image");
    await Bun.write(output, Bun.file(input));
    return { bytes: 1234, width: 1600, height: 1200 };
  }
}

let dir: string;
let encoder: FakeEncoder;
let store: PhotoStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "places-photos-"));
  encoder = new FakeEncoder();
  store = new PhotoStore({ dir, maxBytes: 1024 * 1024, ttlHours: 24, encoder });
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe("sniffImageType", () => {
  test("recognises the formats a phone produces", () => {
    expect(sniffImageType(JPEG)).toBe("jpeg");
    expect(sniffImageType(PNG)).toBe("png");

    const webp = new Uint8Array(16);
    webp.set(new TextEncoder().encode("RIFF"), 0);
    webp.set(new TextEncoder().encode("WEBP"), 8);
    expect(sniffImageType(webp)).toBe("webp");

    const heic = new Uint8Array(16);
    heic.set(new TextEncoder().encode("ftyp"), 4);
    heic.set(new TextEncoder().encode("heic"), 8);
    expect(sniffImageType(heic)).toBe("heic");
  });

  test("refuses anything else", () => {
    expect(sniffImageType(NOT_AN_IMAGE)).toBeNull();
    expect(sniffImageType(new Uint8Array(3))).toBeNull();
  });
});

describe("staging", () => {
  test("returns an id and leaves exactly one file behind", async () => {
    const staged = await store.stage(JPEG);

    expect(staged.id).toMatch(/^[0-9a-f]{12}$/);
    expect(staged.bytes).toBe(1234);
    expect(staged.width).toBe(1600);

    // The raw upload is gone; only the encoded copy remains.
    expect(await readdir(dir)).toEqual([`${staged.id}.jpg`]);
  });

  test("the encoder is what produces the stored file", async () => {
    const staged = await store.stage(PNG);
    expect(encoder.calls).toHaveLength(1);
    expect(encoder.calls[0].output).toBe(staged.path);
  });

  test("refuses an empty upload", async () => {
    await expect(store.stage(new Uint8Array(0))).rejects.toThrow(ValidationError);
  });

  test("refuses something that is not an image", async () => {
    await expect(store.stage(NOT_AN_IMAGE)).rejects.toThrow(/JPEG, PNG, WebP or HEIC/);
  });

  test("refuses an upload over the limit, and says the limit", async () => {
    const small = new PhotoStore({ dir, maxBytes: 8, ttlHours: 24, encoder });
    await expect(small.stage(JPEG)).rejects.toThrow(/larger than/);
  });

  test("a failed encode leaves nothing behind", async () => {
    encoder.shouldFail = true;
    await expect(store.stage(JPEG)).rejects.toThrow(ValidationError);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("claiming", () => {
  test("returns the path so the vault can move rather than copy", async () => {
    const staged = await store.stage(JPEG);
    expect(await store.claim(staged.id)).toBe(staged.path);
  });

  test("a photo that expired, or never existed", async () => {
    await expect(store.claim("aaaaaaaaaaaa")).rejects.toThrow(PhotoNotFoundError);
  });

  test("an id shaped like a path is refused before it touches the filesystem", async () => {
    await expect(store.claim("../../../etc/passwd")).rejects.toThrow(ValidationError);
    expect(() => store.pathFor("nope")).toThrow(ValidationError);
  });

  test("discarding is idempotent", async () => {
    const staged = await store.stage(JPEG);
    await store.discard(staged.id);
    await store.discard(staged.id);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("pruning", () => {
  test("removes what nobody claimed, and keeps what is recent", async () => {
    const stale = await store.stage(JPEG);
    const fresh = await store.stage(PNG);

    const longAgo = new Date(Date.now() - 48 * 3_600_000);
    await utimes(stale.path, longAgo, longAgo);

    expect(await store.prune()).toBe(1);
    expect(await readdir(dir)).toEqual([`${fresh.id}.jpg`]);
  });

  test("a half-finished upload is swept too", async () => {
    const orphan = join(dir, "abcabcabcabc.upload");
    await writeFile(orphan, "interrupted");
    const longAgo = new Date(Date.now() - 48 * 3_600_000);
    await utimes(orphan, longAgo, longAgo);

    expect(await store.prune()).toBe(1);
  });
});

describe("photoFilename", () => {
  test("dates the file and names it after what is in it", () => {
    expect(photoFilename("2026-04-12", ["papoila-das-searas"], [])).toBe(
      "2026-04-12-papoila-das-searas.jpg",
    );
  });

  test("several photos of the same thing on the same day get numbered", () => {
    const taken = ["2026-04-12-cardo.jpg"];
    expect(photoFilename("2026-04-12", ["cardo"], taken)).toBe("2026-04-12-cardo-2.jpg");
    expect(photoFilename("2026-04-12", ["cardo"], [...taken, "2026-04-12-cardo-2.jpg"])).toBe(
      "2026-04-12-cardo-3.jpg",
    );
  });

  test("a meal with no species still gets a usable name", () => {
    expect(photoFilename("2026-05-03", [], [])).toBe("2026-05-03-foto.jpg");
  });

  test("a very long list of species does not produce a very long filename", () => {
    const name = photoFilename("2026-04-12", ["papoila-das-searas", "malmequer-bravo", "cardo"], []);
    expect(name.length).toBeLessThanOrEqual(56);
    expect(name.endsWith(".jpg")).toBe(true);
  });
});
