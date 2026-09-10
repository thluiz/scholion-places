// describe.test.ts
//
// The description is a convenience, so what matters is that it never becomes a
// liability: every way this can fail has to end in "no description" rather than
// in "no photograph".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { describeImage, tidy, type DescribeOptions } from "./describe";

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

let calls: { url: string; body: any }[];
const realFetch = globalThis.fetch;

function options(overrides: Partial<DescribeOptions> = {}): DescribeOptions {
  return {
    enabled: true,
    url: "http://gateway/v1/chat/completions",
    model: "algum/modelo",
    prompt: "Descreve.",
    timeoutMs: 1000,
    maxChars: 100,
    ...overrides,
  };
}

/**
 * A stand-in for fetch that honours the abort signal.
 *
 * Without that, a stub makes the timeout test pass no matter what the code
 * does — it would be testing the double, not the module.
 */
function respondWith(handler: () => Promise<Response> | Response): void {
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });

    const signal: AbortSignal | undefined = init?.signal;
    const answer = Promise.resolve(handler());
    if (!signal) return answer;

    return await Promise.race([
      answer,
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
          once: true,
        });
      }),
    ]);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the request shape", () => {
  test("sends the gateway's own image part, not the OpenAI one", async () => {
    // Getting this wrong is silent: the image is dropped and the provider
    // complains about `undefined`, which looks like a model problem.
    respondWith(() => Response.json({ choices: [{ message: { content: "duas papoilas" } }] }));
    await describeImage(BYTES, options());

    const parts = calls[0].body.messages[0].content;
    expect(parts[1].type).toBe("image");
    expect(parts[1].mediaType).toBe("image/jpeg");
    expect(typeof parts[1].data).toBe("string");
    expect(parts.some((p: any) => p.type === "image_url")).toBe(false);
  });

  test("the image travels as base64 of exactly the bytes given", async () => {
    respondWith(() => Response.json({ choices: [{ message: { content: "x" } }] }));
    await describeImage(BYTES, options());

    const encoded = calls[0].body.messages[0].content[1].data;
    expect(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))).toEqual(BYTES);
  });

  test("a large image does not blow up the encoder", async () => {
    respondWith(() => Response.json({ choices: [{ message: { content: "x" } }] }));
    const big = new Uint8Array(300_000).fill(7);
    expect(await describeImage(big, options())).toBe("x");
  });
});

describe("every failure ends in null, never in a throw", () => {
  test("turned off", async () => {
    respondWith(() => Response.json({}));
    expect(await describeImage(BYTES, options({ enabled: false }))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("no url configured", async () => {
    expect(await describeImage(BYTES, options({ url: "" }))).toBeNull();
  });

  test("the gateway refuses", async () => {
    respondWith(() => new Response("nope", { status: 502 }));
    expect(await describeImage(BYTES, options())).toBeNull();
  });

  test("the gateway is unreachable", async () => {
    respondWith(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await describeImage(BYTES, options())).toBeNull();
  });

  test("the answer is not JSON", async () => {
    respondWith(() => new Response("<html>", { status: 200 }));
    expect(await describeImage(BYTES, options())).toBeNull();
  });

  test("the answer has no content", async () => {
    respondWith(() => Response.json({ choices: [] }));
    expect(await describeImage(BYTES, options())).toBeNull();
    respondWith(() => Response.json({ choices: [{ message: { content: "   " } }] }));
    expect(await describeImage(BYTES, options())).toBeNull();
  });

  test("the gateway takes too long", async () => {
    respondWith(async () => {
      await Bun.sleep(200);
      return Response.json({ choices: [{ message: { content: "tarde demais" } }] });
    });
    expect(await describeImage(BYTES, options({ timeoutMs: 20 }))).toBeNull();
  });
});

describe("tidy", () => {
  test("collapses whitespace into one line", () => {
    expect(tidy("  duas papoilas\n  no lado sul ", 100)).toBe("duas papoilas no lado sul");
  });

  test("prefers to end on a sentence", () => {
    const text = "Um campo aberto com papoilas. Ao fundo vê-se um muro de pedra antigo e comprido.";
    const short = tidy(text, 45);
    expect(short).toBe("Um campo aberto com papoilas.");
  });

  test("otherwise cuts on a space and says it was cut", () => {
    const text = "papoilas malmequeres cardos acafrao bardanas silvas urtigas fetos musgos liquenes";
    const short = tidy(text, 30);
    expect(short.length).toBeLessThanOrEqual(31);
    expect(short.endsWith("…")).toBe(true);
    expect(short).not.toContain("  ");
  });

  test("leaves a short description alone", () => {
    expect(tidy("duas papoilas", 100)).toBe("duas papoilas");
  });
});
