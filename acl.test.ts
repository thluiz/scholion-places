// acl.test.ts
//
// A permissions test that only proves the allowed path works proves nothing: a
// function returning true unconditionally passes it. Almost every assertion
// here is about something being refused, or about a mistake in the file being
// caught before it becomes a silent grant.

import { describe, expect, test } from "bun:test";

import {
  Acl,
  AuthenticationError,
  AuthorizationError,
  MUTATING,
  OPERATIONS,
  ROLE_OPERATIONS,
  assertOperation,
  unknownOperations,
  type AclFile,
} from "./acl";

const KEY = (letter: string) => letter.repeat(32);

const FILE: AclFile = {
  principals: {
    thiago: { apiKey: KEY("a"), role: "admin" },
    thilia: { apiKey: KEY("b"), role: "write" },
    oficina: { apiKey: KEY("c"), role: "write", deny: ["place.update"] },
    intake: { apiKey: KEY("d"), role: "read", allow: ["photo.upload"] },
    painel: { apiKey: KEY("e"), role: "read" },
  },
};

const acl = new Acl(FILE);
const thiago = acl.authenticate(KEY("a"));
const thilia = acl.authenticate(KEY("b"));
const oficina = acl.authenticate(KEY("c"));
const intake = acl.authenticate(KEY("d"));
const painel = acl.authenticate(KEY("e"));

describe("authentication", () => {
  test("no key at all", () => {
    expect(() => acl.authenticate(null)).toThrow(AuthenticationError);
    expect(() => acl.authenticate("")).toThrow(AuthenticationError);
  });

  test("a key nobody holds", () => {
    expect(() => acl.authenticate(KEY("z"))).toThrow(AuthenticationError);
  });

  test("a key resolves to the name the audit log will record", () => {
    expect(thilia.name).toBe("thilia");
  });
});

describe("roles", () => {
  test("read cannot write anything", () => {
    for (const operation of MUTATING) {
      expect(painel.operations.has(operation)).toBe(false);
    }
  });

  test("write can record and correct, but not delete a place or rename it", () => {
    expect(thilia.operations.has("place.create")).toBe(true);
    expect(thilia.operations.has("entry.update")).toBe(true);
    expect(thilia.operations.has("entry.delete")).toBe(true);
    expect(thilia.operations.has("place.delete")).toBe(false);
    expect(thilia.operations.has("place.rename")).toBe(false);
  });

  test("admin reaches everything the API can do", () => {
    for (const operation of OPERATIONS) expect(thiago.operations.has(operation)).toBe(true);
  });

  test("the role tables name only real operations", () => {
    const known = new Set<string>(OPERATIONS);
    for (const operations of Object.values(ROLE_OPERATIONS)) {
      for (const operation of operations) expect(known.has(operation)).toBe(true);
    }
  });
});

describe("allow and deny", () => {
  test("deny subtracts from the role", () => {
    expect(oficina.operations.has("place.update")).toBe(false);
    expect(oficina.operations.has("entry.create")).toBe(true);
  });

  test("allow adds one capability without granting the role that normally carries it", () => {
    expect(intake.operations.has("photo.upload")).toBe(true);
    expect(intake.operations.has("place.create")).toBe(false);
    expect(intake.operations.has("photo.attach")).toBe(false);
  });

  test("deny wins over allow, so the narrower statement is the one that holds", () => {
    const narrowed = new Acl({
      principals: { x: { apiKey: KEY("f"), role: "write", allow: ["place.delete"], deny: ["place.delete"] } },
    }).authenticate(KEY("f"));
    expect(narrowed.operations.has("place.delete")).toBe(false);
  });
});

describe("assertOperation", () => {
  test("refuses, and names both the principal and what it tried", () => {
    expect(() => assertOperation(painel, "place.create")).toThrow(AuthorizationError);
    expect(() => assertOperation(painel, "place.create")).toThrow(/painel/);
    expect(() => assertOperation(painel, "place.create")).toThrow(/place.create/);
  });

  test("permits what the principal holds", () => {
    expect(() => assertOperation(painel, "places.search")).not.toThrow();
  });
});

describe("the file is checked before it is trusted", () => {
  test("no principals at all", () => {
    expect(() => new Acl({ principals: {} })).toThrow(/principals is empty/);
  });

  test("a principal with no key", () => {
    expect(() => new Acl({ principals: { x: { role: "read" } as never } })).toThrow(/no apiKey/);
  });

  test("two principals sharing a key — the audit trail would lie", () => {
    expect(
      () =>
        new Acl({
          principals: { a: { apiKey: KEY("a"), role: "read" }, b: { apiKey: KEY("a"), role: "admin" } },
        }),
    ).toThrow(/share an apiKey/);
  });

  test("a role that does not exist", () => {
    expect(() => new Acl({ principals: { x: { apiKey: KEY("a"), role: "owner" as never } } })).toThrow(/role/);
  });

  test("a name that could not be a URL path segment", () => {
    expect(() => new Acl({ principals: { "../etc": { apiKey: KEY("a"), role: "read" } } })).toThrow(
      /URL path/,
    );
  });

  test("a deny list that is not a list", () => {
    expect(
      () => new Acl({ principals: { x: { apiKey: KEY("a"), role: "read", deny: "tudo" as never } } }),
    ).toThrow(/list of operation names/);
  });
});

describe("unknownOperations", () => {
  test("a typo in a deny list looks like a control and is none", () => {
    expect(
      unknownOperations({
        principals: { x: { apiKey: KEY("a"), role: "write", deny: ["place.destroy", "place.delete"] } },
      }),
    ).toEqual(["place.destroy"]);
  });

  test("a correct file reports nothing", () => {
    expect(unknownOperations(FILE)).toEqual([]);
  });
});
