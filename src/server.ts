/**
 * Server factory — pure so tests can connect it to an InMemoryTransport
 * while `index.ts` connects it to stdio.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { StellaraConfig } from "./config.js";
import { registerPrompts } from "./prompts.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

export interface CreateServerOptions {
  config: StellaraConfig;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: "stellara-mcp", version: VERSION },
    {
      // Read by the host model at `initialize`. Hosts such as Grok, ChatGPT and
      // Gemini decide on their own whether a connector is relevant, so the text
      // must say WHEN to use the tools (triggers, in English and Russian) and
      // forbid the failure mode we saw in production: answering a natal-chart
      // request from web search / memory without ever calling the server.
      instructions:
        "Stellara — deterministic Swiss Ephemeris calculator for astrology (no AI inside, no guessing). " +
        "USE THESE TOOLS whenever the conversation involves a natal chart / birth chart, a horoscope " +
        "(daily, weekly, monthly, yearly), transits or a forecast, synastry / compatibility of two people, " +
        "or whenever a birth date, birth time and birth place come up — even when the user does not " +
        "mention Stellara by name (Russian triggers: гороскоп, натальная карта, транзиты, совместимость, " +
        "дата и время рождения). NEVER compute planetary positions, houses, Ascendant, aspects, " +
        "coordinates or UTC offsets yourself and never web-search them: the tools return exact values. " +
        "Workflow: (1) resolve_birth_place with the place name and the LOCAL wall-clock birth time → " +
        "coordinates, IANA timezone and a tz-aware birth_datetime; (2) calculate_natal_chart for the " +
        "birth chart, get_transits_and_aspects for 'what is going on for me now / today / this week' " +
        "and any dated horoscope, calculate_synastry for two people; (3) interpret ONLY the returned " +
        "JSON. Unknown birth time: still call the tools with the date only (noon is assumed) — say so " +
        "and skip houses / Ascendant. Load the astrologer_system_prompt prompt for a professional " +
        "interpretation style.",
    },
  );
  registerTools(server, { config: options.config, fetchImpl: options.fetchImpl });
  registerPrompts(server);
  return server;
}
