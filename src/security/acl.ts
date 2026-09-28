// acl.ts — who may do what.
//
// The service offers the full set of operations, including the destructive
// ones, because everything it writes is in git and a mistake is recoverable.
// What a given caller may *reach* is a separate question, and this file is the
// answer to it.
//
// That separation is the lesson from the sibling service, learned the expensive
// way: an instruction in a prompt is a suggestion, an absent capability is a
// boundary. So a denied operation is not merely refused when called — it is
// left out of the list the caller is shown, so a model never sees it to try.
//
// Principals are people and rooms — thiago, thilia, oficina, intake. Never
// bots. The bot on the other end is a deployment detail, and swapping it must
// not touch anything in here.

import { readFile } from "node:fs/promises";

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Every operation the API can perform, named once.
 *
 * These strings appear in acl.json, in the audit log and in the response to
 * `GET /me`. Renaming one silently widens or narrows somebody's access, so they
 * are treated as a stable interface.
 */
export const OPERATIONS = [
  "places.search",
  "places.get",
  "places.labels",
  "place.create",
  "place.update",
  "place.delete",
  "place.rename",
  "entry.create",
  "entry.update",
  "entry.delete",
  "photo.upload",
  "photo.attach",
  "photo.update",
  "photo.detach",
  "admin.render",
  "admin.reindex",
] as const;

export type Operation = (typeof OPERATIONS)[number];

export const MUTATING: ReadonlySet<string> = new Set<string>([
  "place.create",
  "place.update",
  "place.delete",
  "place.rename",
  "entry.create",
  "entry.update",
  "entry.delete",
  "photo.upload",
  "photo.attach",
  "photo.update",
  "photo.detach",
  "admin.render",
]);

export type Role = "read" | "write" | "admin";

const READ_OPERATIONS: Operation[] = ["places.search", "places.get", "places.labels"];

/**
 * What each role gets before `allow` and `deny` are applied.
 *
 * `write` deliberately stops short of deleting and renaming. Not because they
 * are dangerous — git remembers — but because they are rare, and a capability
 * that is rarely needed is better requested than left lying around.
 */
export const ROLE_OPERATIONS: Record<Role, Operation[]> = {
  read: READ_OPERATIONS,
  write: [
    ...READ_OPERATIONS,
    "place.create",
    "place.update",
    "entry.create",
    "entry.update",
    "entry.delete",
    "photo.upload",
    "photo.attach",
    "photo.update",
    "photo.detach",
  ],
  admin: [...OPERATIONS],
};

export interface PrincipalConfig {
  apiKey: string;
  role: Role;
  /** Operations added on top of the role. */
  allow?: string[];
  /** Operations removed from the role. Wins over `allow`. */
  deny?: string[];
}

export interface AclFile {
  principals: Record<string, PrincipalConfig>;
}

export interface Principal {
  readonly name: string;
  readonly role: Role;
  readonly operations: ReadonlySet<string>;
}

const ROLES: Role[] = ["read", "write", "admin"];

export class Acl {
  private readonly byKey = new Map<string, Principal>();
  private readonly all: Principal[] = [];

  constructor(file: AclFile) {
    const principals = file?.principals;
    if (!principals || typeof principals !== "object" || !Object.keys(principals).length) {
      throw new Error("acl: principals is empty");
    }

    for (const [name, config] of Object.entries(principals)) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
        throw new Error(`acl: principal name ${JSON.stringify(name)} is not usable in a URL path`);
      }
      if (!config || typeof config.apiKey !== "string" || !config.apiKey) {
        throw new Error(`acl: principal ${name} has no apiKey`);
      }
      if (this.byKey.has(config.apiKey)) {
        throw new Error(`acl: two principals share an apiKey; ${name} is one of them`);
      }
      if (!ROLES.includes(config.role)) {
        throw new Error(`acl: principal ${name} has role ${JSON.stringify(config.role)}`);
      }
      if (config.apiKey.length < 24) {
        console.warn(`[acl] the key for ${name} is short; 24+ random characters is the minimum worth having`);
      }

      const operations = new Set<string>(ROLE_OPERATIONS[config.role]);
      for (const operation of assertOperationList(config.allow, `${name}.allow`)) {
        operations.add(operation);
      }
      for (const operation of assertOperationList(config.deny, `${name}.deny`)) {
        operations.delete(operation);
      }

      const principal: Principal = { name, role: config.role, operations };
      this.byKey.set(config.apiKey, principal);
      this.all.push(principal);
    }
  }

  static async load(path: string): Promise<Acl> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      throw new Error(`acl: cannot read ${path}: ${error instanceof Error ? error.message : error}`);
    }
    return new Acl(JSON.parse(raw));
  }

  principals(): Principal[] {
    return [...this.all];
  }

  authenticate(apiKey: string | null | undefined): Principal {
    if (!apiKey) throw new AuthenticationError("Missing X-Api-Key");
    const principal = this.byKey.get(apiKey);
    if (!principal) throw new AuthenticationError("Unknown X-Api-Key");
    return principal;
  }
}

function assertOperationList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`acl: ${field} must be a list of operation names`);
  }
  return value as string[];
}

export function assertOperation(principal: Principal, operation: Operation): void {
  if (!principal.operations.has(operation)) {
    throw new AuthorizationError(`${principal.name} may not ${operation}`);
  }
}

/**
 * Names in `allow`/`deny` that match no operation.
 *
 * A typo in a deny list looks exactly like a control and is none, so it is
 * shouted about at boot and on every reload rather than left to be discovered
 * by whatever it failed to prevent.
 */
export function unknownOperations(file: AclFile): string[] {
  const known = new Set<string>(OPERATIONS);
  const unknown = new Set<string>();
  for (const config of Object.values(file.principals ?? {})) {
    for (const operation of [...(config.allow ?? []), ...(config.deny ?? [])]) {
      if (!known.has(operation)) unknown.add(operation);
    }
  }
  return [...unknown].sort();
}
