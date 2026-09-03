// photos.ts — the staging area, and the one place that shrinks an image.
//
// Uploading and attaching are two steps because whoever holds the photo does
// not always know yet where it belongs. A phone on a trail sends the picture
// first and works out the place afterwards; a script may upload ten and sort
// them later. Splitting the two is also what keeps the upload usable by
// anything that can POST a file, rather than only by the client we happen to
// have today.
//
// A staged photo that nobody claims is rubbish, and rubbish in a git repository
// is forever. So staging lives outside the vault and expires.
//
// Re-encoding is not an optimisation, it is the only lever on repository size:
// git never forgets a blob, and three thousand untouched phone photos would add
// gigabytes that no later decision can take back. It also drops EXIF, which
// carries a GPS fix and a device serial that nobody asked to publish.

import { spawn } from "bun";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { ValidationError } from "./model";

export class PhotoNotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "PhotoNotFoundError";
  }
}

export interface StagedPhoto {
  id: string;
  path: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface EncodeResult {
  bytes: number;
  width?: number;
  height?: number;
}

export interface PhotoEncoder {
  encode(input: string, output: string): Promise<EncodeResult>;
}

const STAGED_ID_RE = /^[0-9a-f]{12}$/;

function mintStagingId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Recognise the formats we are willing to hand to the encoder.
 *
 * Not security theatre: the point is a clear refusal now instead of an obscure
 * decoder error later, and a hard stop before an arbitrary file is written into
 * a published repository.
 */
export function sniffImageType(data: Uint8Array): string | null {
  if (data.length < 12) return null;
  const [a, b, c, d] = data;
  if (a === 0xff && b === 0xd8 && c === 0xff) return "jpeg";
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return "png";

  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...data.subarray(offset, offset + length));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (["heic", "heix", "mif1", "msf1", "hevc"].includes(brand)) return "heic";
  }
  return null;
}

/** Shell out to ffmpeg — the only image tool installed on the host. */
export class FfmpegEncoder implements PhotoEncoder {
  constructor(
    private readonly maxPx: number,
    private readonly quality: number,
    private readonly ffmpeg = "ffmpeg",
    private readonly ffprobe = "ffprobe",
  ) {}

  async encode(input: string, output: string): Promise<EncodeResult> {
    // The min() around the target box is what stops a small photo being blown
    // up to the cap: the box never exceeds the image's own size.
    const scale = `scale='min(${this.maxPx},iw)':'min(${this.maxPx},ih)':force_original_aspect_ratio=decrease`;

    const process = spawn({
      cmd: [
        this.ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", input,
        "-vf", scale,
        "-frames:v", "1",
        "-q:v", String(this.quality),
        "-map_metadata", "-1", // EXIF, including where and on what it was taken
        output,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await process.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(process.stderr).text();
      throw new ValidationError(`could not read that image: ${stderr.trim().slice(0, 200)}`);
    }

    const { size } = await stat(output);
    return { bytes: size, ...(await this.dimensions(output)) };
  }

  private async dimensions(path: string): Promise<{ width?: number; height?: number }> {
    try {
      const process = spawn({
        cmd: [
          this.ffprobe,
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=width,height",
          "-of", "csv=p=0",
          path,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await process.exited) !== 0) return {};
      const [width, height] = (await new Response(process.stdout).text()).trim().split(",").map(Number);
      return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {};
    } catch {
      return {}; // Dimensions are a convenience; their absence is not a failure.
    }
  }
}

export interface PhotoStoreOptions {
  dir: string;
  maxBytes: number;
  ttlHours: number;
  encoder: PhotoEncoder;
}

export class PhotoStore {
  private readonly ready: Promise<unknown>;

  constructor(private readonly options: PhotoStoreOptions) {
    this.ready = mkdir(options.dir, { recursive: true, mode: 0o750 });
  }

  pathFor(id: string): string {
    if (!STAGED_ID_RE.test(id)) throw new ValidationError(`${id} is not a photo id`);
    return join(this.options.dir, `${id}.jpg`);
  }

  async stage(data: Uint8Array): Promise<StagedPhoto> {
    if (!data.length) throw new ValidationError("the upload was empty");
    if (data.length > this.options.maxBytes) {
      const mb = (this.options.maxBytes / 1024 / 1024).toFixed(0);
      throw new ValidationError(`the image is larger than the ${mb} MB limit`);
    }

    const kind = sniffImageType(data);
    if (!kind) throw new ValidationError("that does not look like a JPEG, PNG, WebP or HEIC image");

    await this.ready;
    const id = mintStagingId();
    const original = join(this.options.dir, `${id}.upload`);
    const encoded = this.pathFor(id);

    await Bun.write(original, data);
    try {
      const result = await this.options.encoder.encode(original, encoded);
      return { id, path: encoded, ...result };
    } finally {
      await unlink(original).catch(() => undefined);
    }
  }

  /**
   * Hand over a staged photo for the vault to move into a bundle.
   *
   * Returns the path rather than the bytes: the vault renames it, so a photo is
   * never copied twice, and a claim that fails halfway leaves the file staged
   * instead of half-written into the repository.
   */
  async claim(id: string): Promise<string> {
    const path = this.pathFor(id);
    if (!(await Bun.file(path).exists())) {
      throw new PhotoNotFoundError(`photo ${id} is not staged; it may have expired`);
    }
    return path;
  }

  async discard(id: string): Promise<void> {
    await unlink(this.pathFor(id)).catch(() => undefined);
  }

  /** Delete what nobody claimed. Called on a timer and at boot. */
  async prune(): Promise<number> {
    await this.ready;
    const cutoff = Date.now() - this.options.ttlHours * 3_600_000;
    let removed = 0;

    for (const name of await readdir(this.options.dir).catch(() => [])) {
      const path = join(this.options.dir, name);
      try {
        const { mtimeMs } = await stat(path);
        if (mtimeMs < cutoff) {
          await unlink(path);
          removed++;
        }
      } catch {
        // Raced with a claim. Nothing to do.
      }
    }
    return removed;
  }
}

/**
 * The name a photo takes once it belongs somewhere.
 *
 * Dated and named after what is in it, so the bundle is legible in a file
 * listing and a photo is still identifiable if it is ever pulled out of the
 * repository on its own.
 */
export function photoFilename(date: string, labels: string[], taken: Iterable<string>): string {
  const subject = labels.length ? labels.join("-").slice(0, 40) : "foto";
  const base = `${date}-${subject}`.replace(/-+/g, "-");
  const used = new Set(taken);

  if (!used.has(`${base}.jpg`)) return `${base}.jpg`;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}.jpg`;
    if (!used.has(candidate)) return candidate;
  }
  throw new ValidationError("too many photos with the same name on one day");
}
