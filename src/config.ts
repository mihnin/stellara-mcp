/**
 * Environment → typed config. Kept pure (takes the env as an argument) so
 * tests never touch `process.env`.
 */

/**
 * Custom domain mapped to the Cloud Run service `stellara-api` (natlex.it
 * hosts several apps, so the API lives under the per-app subdomain). The
 * raw Cloud Run URL keeps working as a fallback:
 * https://stellara-api-923668916124.us-central1.run.app/api/v1/astrology
 */
export const DEFAULT_BASE_URL = "https://api.stellara.natlex.it/api/v1/astrology";

export const DEFAULT_TIMEOUT_MS = 15_000;

export const KEY_HELP =
  "STELLARA_API_KEY is not set. This server proxies the Stellara Swiss Ephemeris API " +
  "and needs an access key. Request one at https://stellara.natlex.it/#api (free during early access; " +
  "or email info@natlex.it), " +
  "then add it to your MCP client config, e.g. " +
  '"env": { "STELLARA_API_KEY": "sk_stellara_..." }. ' +
  "Optional: STELLARA_API_BASE_URL to point at another deployment.";

export interface StellaraConfig {
  /** Access key sent as `X-API-Key`. `undefined` = not configured. */
  apiKey: string | undefined;
  /**
   * Remote mode (Streamable HTTP): the credential the MCP client presented —
   * an OAuth access token (`typ=mcp`) or an `sk_stellara_` key — forwarded
   * to the API as `Authorization: Bearer …`. Takes precedence over `apiKey`.
   */
  bearerToken?: string;
  /** Base URL of the astrology API, without trailing slash. */
  baseUrl: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

export function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

export function readConfig(env: Record<string, string | undefined> = process.env): StellaraConfig {
  const key = (env.STELLARA_API_KEY ?? "").trim();
  const timeoutRaw = Number.parseInt((env.STELLARA_TIMEOUT_MS ?? "").trim(), 10);
  const timeoutMs = Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS;
  return {
    apiKey: key.length > 0 ? key : undefined,
    baseUrl: normalizeBaseUrl(env.STELLARA_API_BASE_URL),
    timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Remote mode (Streamable HTTP on Cloud Run — PR 4 of docs/MCP_PHASE2_PLAN.ru.md)
// ---------------------------------------------------------------------------

/** Public origin of the remote MCP service (Cloud Run domain mapping). */
export const DEFAULT_MCP_PUBLIC_URL = "https://mcp.stellara.natlex.it";
/** The OAuth 2.1 authorization server = the Stellara backend (routers/oauth). */
export const DEFAULT_OAUTH_ISSUER = "https://api.stellara.natlex.it";
export const DEFAULT_PORT = 8080;
/** The MCP endpoint path; `<publicUrl>/mcp` is the RFC 8707 resource / JWT `aud`. */
export const MCP_PATH = "/mcp";

export interface RemoteConfig {
  /** `https://mcp.stellara.natlex.it` — no trailing slash. */
  publicUrl: string;
  /** `<publicUrl>/mcp` — what tokens must carry as `aud`. */
  resourceUrl: string;
  /** RFC 8414 issuer of the authorization server (JWT `iss`). */
  issuer: string;
  /** HS256 secret shared with the backend (Secret Manager `jwt-secret`). */
  jwtSecret: string;
  /** Astrology API base URL (same as stdio mode). */
  baseUrl: string;
  timeoutMs: number;
  port: number;
  /**
   * Glama connector ownership claim (env `GLAMA_CLAIM_TOKEN`, optional). When set,
   * `GET /.well-known/glama.json` publishes it so Glama can verify that we control
   * the connector's origin (https://glama.ai/mcp/connectors/it.natlex/stellara-mcp → Admin).
   * Public by design — it proves origin control, it grants nothing.
   */
  glamaClaimToken?: string;
}

function stripSlashes(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  return trimmed || fallback;
}

/**
 * Environment → remote config. Throws when `JWT_SECRET` is missing: without
 * it no token could ever verify, so failing at startup beats a service that
 * answers 401 to everyone.
 */
export function readRemoteConfig(env: Record<string, string | undefined> = process.env): RemoteConfig {
  const jwtSecret = (env.JWT_SECRET ?? "").trim();
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is not set — the remote MCP cannot verify OAuth access tokens without it.");
  }
  const publicUrl = stripSlashes(env.MCP_PUBLIC_URL, DEFAULT_MCP_PUBLIC_URL);
  const portRaw = Number.parseInt((env.PORT ?? "").trim(), 10);
  const base = readConfig(env);
  return {
    publicUrl,
    resourceUrl: `${publicUrl}${MCP_PATH}`,
    issuer: stripSlashes(env.OAUTH_ISSUER, DEFAULT_OAUTH_ISSUER),
    jwtSecret,
    baseUrl: base.baseUrl,
    timeoutMs: base.timeoutMs,
    port: Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : DEFAULT_PORT,
    glamaClaimToken: (env.GLAMA_CLAIM_TOKEN ?? "").trim() || undefined,
  };
}
