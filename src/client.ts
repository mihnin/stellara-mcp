/**
 * Typed HTTP client for the Stellara astrology API.
 *
 * Responsibilities: URL joining, auth header, JSON encode/decode, a hard
 * timeout via AbortController, and translating every failure mode into a
 * `StellaraApiError` with a stable `kind` the tools can phrase for the
 * agent. It deliberately knows nothing about MCP.
 */
import { normalizeBaseUrl } from "./config.js";
import { VERSION } from "./version.js";

export type StellaraEndpoint = "natal" | "transits" | "synastry" | "resolve-place";

export type StellaraErrorKind =
  | "unauthorized" // 401 / 403 — key missing on the server side, invalid or revoked
  | "not_found" // 404 — e.g. the geocoder could not resolve the place
  | "rate_limited" // 429 — per-minute burst limit (slowapi); wait a moment
  | "quota_exceeded" // 429 + detail QUOTA_EXCEEDED — the key's DAILY quota; resets 00:00 UTC
  | "validation" // 400 / 422 — the backend rejected the payload
  | "server" // 5xx or an unparseable body
  | "network" // DNS / TCP / TLS failure
  | "timeout"; // exceeded timeoutMs

export class StellaraApiError extends Error {
  readonly kind: StellaraErrorKind;
  readonly status: number | undefined;
  readonly detail: unknown;
  /** Seconds until the quota resets, from a numeric `Retry-After` header (429 only). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    kind: StellaraErrorKind,
    message: string,
    status?: number,
    detail?: unknown,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "StellaraApiError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface StellaraClientOptions {
  /** `X-API-Key` credential (stdio mode). Ignored when `bearerToken` is set. */
  apiKey?: string;
  /** Remote mode: forwarded verbatim as `Authorization: Bearer …`. */
  bearerToken?: string;
  baseUrl: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to the global fetch (Node ≥ 18). */
  fetchImpl?: typeof fetch;
}

const QUOTA_EXCEEDED = "QUOTA_EXCEEDED";

function detailToken(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && "code" in detail) {
      const code = (detail as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

function kindFor(status: number, payload: unknown): StellaraErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return detailToken(payload) === QUOTA_EXCEEDED ? "quota_exceeded" : "rate_limited";
  if (status === 400 || status === 422) return "validation";
  return "server";
}

function retryAfterOf(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class StellaraClient {
  private readonly authHeaders: Record<string, string>;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StellaraClientOptions) {
    if (options.bearerToken) {
      this.authHeaders = { authorization: `Bearer ${options.bearerToken}` };
    } else if (options.apiKey) {
      this.authHeaders = { "x-api-key": options.apiKey };
    } else {
      throw new Error("StellaraClient needs an apiKey or a bearerToken");
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async post<T = unknown>(endpoint: StellaraEndpoint, body: unknown): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...this.authHeaders,
          "user-agent": `stellara-mcp/${VERSION}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new StellaraApiError(
          "timeout",
          `Stellara API ${endpoint} request timed out after ${this.timeoutMs} ms.`,
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new StellaraApiError(
        "network",
        `Could not reach the Stellara API at ${url} (${reason}).`,
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = await readBody(response);

    if (!response.ok) {
      const kind = kindFor(response.status, payload);
      throw new StellaraApiError(
        kind,
        `Stellara API ${endpoint} responded with HTTP ${response.status}.`,
        response.status,
        payload,
        kind === "quota_exceeded" ? retryAfterOf(response) : undefined,
      );
    }

    if (payload === undefined || typeof payload === "string") {
      throw new StellaraApiError(
        "server",
        `Stellara API ${endpoint} returned a non-JSON body (HTTP ${response.status}).`,
        response.status,
        payload,
      );
    }

    return payload as T;
  }
}
