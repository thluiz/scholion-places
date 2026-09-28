// photos.ts — uploading a photograph, attaching it to a visit, and taking it off.

import { ValidationError, assertId, assertSlug, optionalString, type Entry } from "../../domain/model";
import { describeImage } from "../../services/describe";
import { NotFoundError } from "../../storage/vault";
import { findEntry, mutate, shapePlace, type Route } from "../api";
import { claimPhotos } from "./photo-files";

/**
 * The bytes of an upload, from a multipart form or from a raw body.
 *
 * Multipart is what `curl -F` sends, which is what a media pipeline is likely
 * to use. The raw path is there so a two-line script does not have to build a
 * multipart body to save a photo.
 */
async function readUpload(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file") ?? form.get("photo") ?? form.get("image");
    if (!(file instanceof File)) {
      throw new ValidationError("send the image as a form field named file");
    }
    if (file.size > maxBytes) throw new ValidationError("the image is larger than the limit");
    return new Uint8Array(await file.arrayBuffer());
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new ValidationError("the image is larger than the limit");
  return new Uint8Array(buffer);
}

export const PHOTO_ROUTES: Route[] = [
  {
    method: "POST",
    pattern: /^\/photos$/,
    operation: "photo.upload",
    async handle(ctx, request) {
      const data = await readUpload(request.raw, ctx.config.photoMaxBytes);
      const staged = await ctx.photos.stage(data);

      const asText = (request.headers.get("accept") ?? "").includes("text/plain");
      const wantsDescription = asText || request.query.get("describe") === "true";

      // Described from the re-encoded copy, not the original: it is smaller,
      // so the round trip is quicker and costs less, and it is the image that
      // will actually be published.
      const description = wantsDescription
        ? await describeImage(
            new Uint8Array(await Bun.file(staged.path).arrayBuffer()),
            ctx.config.describe,
          )
        : null;

      // A caller that asks for text gets one short line back. That is what a
      // media pipeline pastes into a message for a model to read, and a few
      // hundred characters is all it is given — so the id comes first, where
      // truncation cannot reach it.
      if (asText) {
        const tail = description
          ? `${description} — passe este id ao registar a visita.`
          : "recebida, por guardar. Passe este id ao registar a visita.";
        return {
          status: 201,
          body: `foto:${staged.id} — ${tail}\n`,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          audit: { photoId: staged.id },
        };
      }

      return {
        status: 201,
        body: {
          id: staged.id,
          bytes: staged.bytes,
          width: staged.width,
          height: staged.height,
          ...(description ? { description } : {}),
        },
        audit: { photoId: staged.id },
      };
    },
  },

  {
    method: "POST",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries\/(?<id>[^/]+)\/photos$/,
    operation: "photo.attach",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      const id = assertId(request.params.id, "entry id");
      let entry: Entry | undefined;

      const stored = await mutate(ctx, slug, request, `places: fotos na entrada ${id} de ${slug}`, async (place) => {
        entry = findEntry(place, id);
        const { attach } = await claimPhotos(ctx, place, entry, request.body.photos);
        return { place, attach };
      });

      return {
        status: 201,
        body: { entry, place: shapePlace(stored) },
        headers: { ETag: `"${stored.etag}"` },
        audit: { slug, entryId: id },
      };
    },
  },

  {
    method: "PATCH",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries\/(?<id>[^/]+)\/photos\/(?<photoId>[^/]+)$/,
    operation: "photo.update",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      const id = assertId(request.params.id, "entry id");
      const photoId = assertId(request.params.photoId, "photo id");

      const stored = await mutate(ctx, slug, request, `places: legenda de ${photoId} em ${slug}`, async (place) => {
        const photo = findEntry(place, id).photos.find((candidate) => candidate.id === photoId);
        if (!photo) throw new NotFoundError(`no photo ${photoId} on entry ${id}`);
        photo.caption = optionalString(request.body.caption, "caption", 300);
        return { place };
      });

      return { body: shapePlace(stored), headers: { ETag: `"${stored.etag}"` }, audit: { slug, entryId: id, photoId } };
    },
  },

  {
    method: "DELETE",
    pattern: /^\/places\/(?<slug>[^/]+)\/entries\/(?<id>[^/]+)\/photos\/(?<photoId>[^/]+)$/,
    operation: "photo.detach",
    async handle(ctx, request) {
      const slug = assertSlug(request.params.slug);
      const id = assertId(request.params.id, "entry id");
      const photoId = assertId(request.params.photoId, "photo id");

      const stored = await mutate(ctx, slug, request, `places: remove foto ${photoId} de ${slug}`, async (place) => {
        const entry = findEntry(place, id);
        const photo = entry.photos.find((candidate) => candidate.id === photoId);
        if (!photo) throw new NotFoundError(`no photo ${photoId} on entry ${id}`);
        entry.photos = entry.photos.filter((candidate) => candidate.id !== photoId);
        return { place, remove: [photo.file] };
      });

      return { body: shapePlace(stored), headers: { ETag: `"${stored.etag}"` }, audit: { slug, entryId: id, photoId } };
    },
  },
];
