// describe.ts — asking something else what is in the photograph.
//
// This exists because of a collision in the client's media pipeline: the hook
// that uploads a photo and the model that describes it occupy the same slot,
// and only one of them can fill the block the model reads. Rather than lose the
// description, the upload brings it along — so one line comes back carrying
// both the id and what the picture appears to show.
//
// Two properties matter more than the description itself:
//
//   - It is best-effort. A photograph that reached the vault and was not
//     described is a good outcome; a photograph refused because a language
//     model was slow is not. Every failure here returns null and is forgotten.
//   - It is never stored. The description is a guess made to help whoever is
//     reading the message decide what to write down. The record holds what a
//     person said was there, not what a model thought it saw.
//
// The request shape is the gateway's own, which is close to but not the
// OpenAI vision format: `{type: "image", mediaType, data}` rather than
// `{type: "image_url", image_url: {url}}`. Sending the standard shape gets the
// image silently dropped and the provider complaining about `undefined`.

export interface DescribeOptions {
  enabled: boolean;
  url: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  maxChars: number;
}

interface CompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * A one-line description of an image, or null.
 *
 * Null is a normal answer: the feature is off, the gateway is down, the model
 * took too long, the reply was empty. The caller carries on either way.
 */
export async function describeImage(
  bytes: Uint8Array,
  options: DescribeOptions,
): Promise<string | null> {
  if (!options.enabled || !options.url) return null;

  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs),
      body: JSON.stringify({
        model: options.model,
        maxTokens: 120,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: options.prompt },
              { type: "image", mediaType: "image/jpeg", data: base64(bytes) },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`[describe] gateway answered ${response.status}`);
      return null;
    }

    const body = (await response.json()) as CompletionResponse;
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

    return tidy(text, options.maxChars);
  } catch (error) {
    console.error(`[describe] ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * One line, within budget.
 *
 * The result is pasted into a message a model reads, and that block is truncated
 * at a few hundred characters by the client. A description cut mid-word is worse
 * than a shorter one, so this cuts at a sentence or a space.
 */
export function tidy(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;

  const cut = oneLine.slice(0, maxChars);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > maxChars / 2) return cut.slice(0, sentence + 1);

  const space = cut.lastIndexOf(" ");
  return `${space > maxChars / 2 ? cut.slice(0, space) : cut}…`;
}

function base64(bytes: Uint8Array): string {
  // Chunked so a few megabytes of photograph do not blow the argument limit of
  // String.fromCharCode.
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
