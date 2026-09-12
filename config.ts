// config.ts — everything the service needs from its environment, read once.
//
// A missing setting is a boot failure, never a surprise at three in the
// morning. The only value with no default is the vault, because guessing where
// somebody's content repository lives is not a favour.

export interface Config {
  port: number;
  host: string;

  /** Where the vault publishes. A search hit's url is built from this, never guessed. */
  siteBaseUrl: string;

  vaultDir: string;
  vaultSection: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  autoPush: boolean;
  pushDelayMs: number;
  /** How often to pull the remote and re-read what changed. */
  syncIntervalMs: number;

  indexPath: string;
  stagingDir: string;
  stagingTtlHours: number;

  aclPath: string;
  logDir: string;
  logRetentionDays: number;
  maxWritesPerMin: number;
  maxWritesPerDay: number;

  /** Decimal places kept in published coordinates. Six is about ten centimetres. */
  coordPrecision: number;
  /** How close a new place may be to an existing one before we assume it is the same. */
  neighbourRadiusM: number;

  photoMaxPx: number;
  photoQuality: number;
  photoMaxBytes: number;
  ffmpegPath: string;

  /**
   * Optional: ask a gateway what the photograph shows, and hand the answer back
   * with the upload. Off by default — it points at a service this repository
   * knows nothing about, and a deployment without one must still work.
   */
  describe: {
    enabled: boolean;
    url: string;
    model: string;
    prompt: string;
    timeoutMs: number;
    maxChars: number;
  };
}

const DESCRIBE_PROMPT =
  "Descreve esta fotografia numa frase curta, em português de Portugal, até 20 palavras. " +
  "Se houver flores, nomeia-as se conseguires; se não tiveres a certeza, descreve-as sem inventar o nome.";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: expected a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`Invalid ${name}: expected a boolean, got ${JSON.stringify(raw)}`);
}

export function loadConfig(): Config {
  const vaultDir = process.env.VAULT_DIR ?? "";
  if (!vaultDir) {
    throw new Error(
      "VAULT_DIR is not set. Copy .env.example to .env and point it at the clone of the content repository.",
    );
  }

  return {
    port: num("PORT", 8010),
    host: process.env.HOST || "127.0.0.1",

    siteBaseUrl: (process.env.SITE_BASE_URL || "https://scholion.thluiz.com").replace(/\/+$/, ""),

    vaultDir,
    vaultSection: process.env.VAULT_SECTION || "content/places",
    gitAuthorName: process.env.GIT_AUTHOR_NAME || "scholion-places",
    gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || "scholion-places@localhost",
    autoPush: bool("AUTO_PUSH", true),
    pushDelayMs: num("PUSH_DELAY_MS", 2_000),
    syncIntervalMs: num("SYNC_INTERVAL_MS", 300_000),

    indexPath: process.env.INDEX_PATH || "./places.db",
    stagingDir: process.env.STAGING_DIR || "./staging",
    stagingTtlHours: num("STAGING_TTL_HOURS", 24),

    aclPath: process.env.ACL_PATH || "./acl.json",
    logDir: process.env.LOG_DIR || "./logs",
    logRetentionDays: num("LOG_RETENTION_DAYS", 30),
    maxWritesPerMin: num("MAX_WRITES_PER_MIN", 30),
    maxWritesPerDay: num("MAX_WRITES_PER_DAY", 400),

    coordPrecision: num("COORD_PRECISION", 6),
    neighbourRadiusM: num("NEIGHBOUR_RADIUS_M", 80),

    photoMaxPx: num("PHOTO_MAX_PX", 1600),
    photoQuality: num("PHOTO_QUALITY", 3),
    photoMaxBytes: num("PHOTO_MAX_BYTES", 12 * 1024 * 1024),
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",

    describe: {
      enabled: bool("DESCRIBE_ENABLED", false),
      url: process.env.DESCRIBE_URL || "",
      model: process.env.DESCRIBE_MODEL || "",
      prompt: process.env.DESCRIBE_PROMPT || DESCRIBE_PROMPT,
      timeoutMs: num("DESCRIBE_TIMEOUT_MS", 15_000),
      maxChars: num("DESCRIBE_MAX_CHARS", 280),
    },
  };
}
