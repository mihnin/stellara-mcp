/**
 * The three MCP tools. Each one validates its input with zod (rejected
 * before any network call), forwards the payload verbatim to the Stellara
 * astrology API and returns the backend JSON both as `structuredContent`
 * and as pretty-printed text. Failures come back as `isError` results with
 * a message the agent can act on (never a stack trace).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { StellaraApiError, StellaraClient, type StellaraEndpoint } from "./client.js";
import { KEY_HELP, type StellaraConfig } from "./config.js";

export const HOUSE_SYSTEMS = [
  "placidus",
  "koch",
  "porphyry",
  "regiomontanus",
  "campanus",
  "equal",
  "whole_sign",
  "topocentric",
  "morinus",
  "alcabitius",
] as const;

const DATETIME_DESCRIPTION =
  "ISO-8601 date-time WITH timezone, e.g. '1990-05-17T14:30:00Z' or '1990-05-17T17:30:00+03:00'. " +
  "Convert the local birth time to an offset yourself; naive values are rejected.";

const chartInputShape = {
  birth_datetime: z.string().datetime({ offset: true }).describe(DATETIME_DESCRIPTION),
  latitude: z.number().min(-90).max(90).describe("Birth latitude in decimal degrees (north positive)"),
  longitude: z.number().min(-180).max(180).describe("Birth longitude in decimal degrees (east positive)"),
  house_system: z
    .enum(HOUSE_SYSTEMS)
    .default("placidus")
    .describe(`House system; default 'placidus'. One of: ${HOUSE_SYSTEMS.join(", ")}`),
};

const chartInputSchema = z.object(chartInputShape);

const includeMinor = z
  .boolean()
  .default(false)
  .describe(
    "Also report minor aspects (semi-sextile, semi-square, quintile, sesquiquadrate, biquintile, quincunx) with tight orbs. Default false = the five major aspects only.",
  );

const targetDatetime = z
  .string()
  .datetime({ offset: true })
  .describe("Moment to compute transits for, ISO-8601 WITH timezone (e.g. now, or a date the user asks about)");

// Naive LOCAL wall time: date, or date + time, never an offset / Z.
const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

const localDatetime = z
  .string()
  .regex(
    LOCAL_DATETIME_RE,
    "local_datetime must be the LOCAL wall-clock time without an offset: 'YYYY-MM-DDTHH:MM' (or 'YYYY-MM-DD' if the time is unknown)",
  )
  .describe(
    "Birth time as the user said it, in LOCAL time WITHOUT an offset: 'YYYY-MM-DDTHH:MM[:SS]'. " +
      "Pass 'YYYY-MM-DD' alone if the time is unknown (12:00 is assumed and flagged). " +
      "Never add +HH:MM or Z here — the server derives the historical offset from the place.",
  );

export interface ToolDeps {
  config: StellaraConfig;
  fetchImpl?: typeof fetch;
}

function textResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function describeDetail(detail: unknown): string {
  if (detail === undefined || detail === null || detail === "") return "";
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

/** How the caller authenticated — decides how auth / quota errors are phrased. */
export type CredentialMode = "api_key" | "bearer";

export function messageForError(error: StellaraApiError, mode: CredentialMode = "api_key"): string {
  const detail = describeDetail(error.detail);
  switch (error.kind) {
    case "unauthorized":
      if (mode === "bearer") {
        return (
          `The Stellara API rejected the credentials (HTTP ${error.status}). ` +
          "If you signed in with a Stellara account, the session is no longer valid — disconnect the Stellara " +
          "connector and connect it again to sign in again. If you use an API key, check it at " +
          "https://stellara.natlex.it/#api."
        );
      }
      return (
        `The Stellara API rejected the access key (HTTP ${error.status}): STELLARA_API_KEY is invalid, ` +
        "revoked or not enabled for this deployment. Request a valid key at https://stellara.natlex.it/#api " +
        "(or email info@natlex.it) and update the MCP client config."
      );
    case "not_found":
      return (
        "Place not found by the geocoder. Try the nearest larger city, add the country " +
        "(e.g. 'Springfield, Illinois, USA'), or use the local-language spelling — then call " +
        "resolve_birth_place again. If the user knows the coordinates, pass them directly to " +
        "calculate_natal_chart."
      );
    case "rate_limited":
      return "Stellara API rate limit reached (60 requests per minute per IP; 20 for resolve_birth_place). Wait a moment and retry.";
    case "quota_exceeded": {
      const eta =
        error.retryAfterSeconds !== undefined
          ? ` (in ~${Math.max(1, Math.round(error.retryAfterSeconds / 60))} min)`
          : "";
      if (mode === "bearer") {
        return (
          "The daily Stellara quota for this account is used up (HTTP 429, QUOTA_EXCEEDED). " +
          `It resets at 00:00 UTC${eta}. Do not retry before then. ` +
          "For more requests per day the user can subscribe to Stellara Pro in the Stellara app, " +
          "or use an API key from https://stellara.natlex.it/#api. Tell the user when the quota resets."
        );
      }
      return (
        "The daily quota for this Stellara API key is used up (HTTP 429, QUOTA_EXCEEDED). " +
        `It resets at 00:00 UTC${eta}. Do not retry before then. ` +
        "For more requests per day upgrade the key at https://stellara.natlex.it/#api, " +
        "or tell the user when the quota resets."
      );
    }
    case "validation":
      return (
        `The Stellara API rejected the request (HTTP ${error.status})${detail ? `: ${detail}` : "."} ` +
        "Check the birth data: ISO-8601 date-time with timezone, latitude -90..90, longitude -180..180, " +
        `house_system one of ${HOUSE_SYSTEMS.join(", ")}.`
      );
    case "server":
      if (error.status === 502 && detail.includes("GEOCODER_UNAVAILABLE")) {
        return (
          "The geocoding service behind resolve_birth_place is temporarily unavailable — the place may " +
          "well exist. Retry in a moment, or ask the user for coordinates and pass them to " +
          "calculate_natal_chart directly."
        );
      }
      return (
        `Stellara API error: ${error.message}${detail ? ` Detail: ${detail}` : ""} ` +
        "The backend may be redeploying — retry in a minute; if it persists, report it at https://github.com/mihnin/stellara-mcp/issues."
      );
    case "network":
      return `${error.message} Check network connectivity and STELLARA_API_BASE_URL (if you overrode it).`;
    case "timeout":
      return `${error.message} Retry; if it keeps happening raise STELLARA_TIMEOUT_MS.`;
  }
}

async function forward(deps: ToolDeps, endpoint: StellaraEndpoint, payload: unknown): Promise<CallToolResult> {
  const mode: CredentialMode = deps.config.bearerToken ? "bearer" : "api_key";
  if (mode === "api_key" && !deps.config.apiKey) {
    return errorResult(KEY_HELP);
  }
  const client = new StellaraClient({
    apiKey: deps.config.apiKey,
    bearerToken: deps.config.bearerToken,
    baseUrl: deps.config.baseUrl,
    timeoutMs: deps.config.timeoutMs,
    fetchImpl: deps.fetchImpl,
  });
  try {
    return textResult(await client.post(endpoint, payload));
  } catch (error) {
    if (error instanceof StellaraApiError) {
      return errorResult(messageForError(error, mode));
    }
    const reason = error instanceof Error ? error.message : String(error);
    return errorResult(`Unexpected error while calling the Stellara API (${endpoint}): ${reason}`);
  }
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "resolve_birth_place",
    {
      title: "Resolve birth place → coordinates, timezone, exact birth instant",
      description:
        "Call this FIRST whenever a birth date / time and a place of birth appear in the conversation — for a " +
        "natal chart, a horoscope, transits or synastry, even if the user does not mention Stellara. Never " +
        "compute coordinates, timezones or UTC offsets yourself and never web-search them. Geocodes the place " +
        "(any language, e.g. 'Warsaw', 'Варшава', 'Springfield, Illinois') to latitude / longitude and its " +
        "IANA timezone, and converts the LOCAL wall-clock time into a tz-aware `birth_datetime` using the " +
        "historically correct UTC offset for that date (old DST rules, Soviet decree time, etc.). Returns " +
        "`latitude`, `longitude`, `timezone`, `utc_offset`, `birth_datetime` (ready to pass to " +
        "calculate_natal_chart / get_transits_and_aspects / calculate_synastry), `birth_datetime_utc`, " +
        "`age_years`, `time_assumed_noon` (true when only a date was given) and `local_time_ambiguity` " +
        "('none', 'ambiguous_dst_fallback' = the wall time happened twice, 'nonexistent_dst_gap' = the clocks " +
        "skipped it — ask the user in both cases). Nothing is stored server-side.",
      inputSchema: {
        place: z
          .string()
          .trim()
          .min(2)
          .max(200)
          .describe("Place of birth as free text, in any language; add region/country for small towns"),
        local_datetime: localDatetime.optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => forward(deps, "resolve-place", args),
  );

  server.registerTool(
    "calculate_natal_chart",
    {
      title: "Calculate natal chart (Swiss Ephemeris)",
      description:
        "Use this tool for ANY natal chart / birth chart or personal horoscope request — never compute or " +
        "recall planetary positions, houses or aspects yourself and never web-search them; call " +
        "resolve_birth_place first when you only have a place name and a local time. " +
        "Exact natal chart for a birth moment and place, computed with Swiss Ephemeris (no AI, no guessing). " +
        "Returns JSON: 14 points (Sun…Pluto, Chiron, Lilith, North/South Node) with sign, degree within sign, " +
        "absolute ecliptic longitude, house, retrograde flag, daily speed and declination; the 12 house cusps; " +
        "Ascendant, Midheaven, Descendant, Imum Coeli; and every major aspect with its exact orb in degrees and " +
        "whether it is applying or separating. Tropical zodiac. Use the result as the only source of positions " +
        "when interpreting.",
      inputSchema: {
        ...chartInputShape,
        include_minor_aspects: includeMinor,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => forward(deps, "natal", args),
  );

  server.registerTool(
    "get_transits_and_aspects",
    {
      title: "Transits to a natal chart",
      description:
        "Use this tool for ANY 'what is going on for me now / today / this week / this month', daily-weekly-" +
        "monthly-yearly horoscope, forecast or transit question — never estimate transiting positions " +
        "yourself and never web-search them. " +
        "Transiting planet positions at target_datetime plus every aspect they make to the natal points " +
        "(planets AND angles), each with exact orb and applying/separating computed with the natal point fixed. " +
        "Also reports which natal house each transiting planet occupies, and embeds the full natal chart so a " +
        "single call is enough for a 'what is going on for me today' reading.",
      inputSchema: {
        natal: chartInputSchema.describe("The person's birth data"),
        target_datetime: targetDatetime,
        include_minor_aspects: includeMinor,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => forward(deps, "transits", args),
  );

  server.registerTool(
    "calculate_synastry",
    {
      title: "Synastry between two people",
      description:
        "Use this tool for ANY compatibility / relationship / synastry question about two people — never " +
        "estimate inter-chart aspects yourself and never web-search them. " +
        "Relationship astrology for two birth charts: every inter-chart aspect (person A's points × person B's " +
        "points, planets and angles) with exact orbs, plus house overlays (A's planets in B's houses and vice " +
        "versa). Both full natal charts are embedded in the response.",
      inputSchema: {
        person_a: chartInputSchema.describe("First person's birth data"),
        person_b: chartInputSchema.describe("Second person's birth data"),
        include_minor_aspects: includeMinor,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => forward(deps, "synastry", args),
  );
}
