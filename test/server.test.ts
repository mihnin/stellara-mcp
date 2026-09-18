/**
 * Behavioural tests for the MCP server, driven through the real protocol
 * (in-process Client ↔ Server over InMemoryTransport). Each test states
 * one observable contract of a tool or prompt.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  DIANA,
  EINSTEIN,
  TEST_ENV,
  connectServer,
  fetchStub,
  hangingFetch,
  requestOf,
  resultText,
  type Harness,
} from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const NATAL_JSON = {
  input: { birth_datetime_utc: "1879-03-14T10:30:00Z", latitude: 48.4011, longitude: 9.9876, house_system: "placidus" },
  planets: [{ name: "Sun", sign: "Pisces", degree: 23.49, absolute_longitude: 353.49, house: 10, retrograde: false, speed: 0.996, declination: -2.58 }],
  houses: [{ house: 1, sign: "Cancer", degree: 7.44, absolute_longitude: 97.44 }],
  angles: { ascendant: { sign: "Cancer", degree: 7.44, absolute_longitude: 97.44 } },
  aspects: [{ point_a: "Sun", point_b: "Mercury", aspect: "conjunction", exact_degrees: 0, orb: 9.63, movement: "separating" }],
  meta: { engine: "Swiss Ephemeris (kerykeion 5.12.7)", zodiac: "tropical", house_system: "placidus" },
};

/** Whether the promise rejected (SDK InvalidParams) — returns the message. */
async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    const r = await p;
    throw new Error(`expected rejection, got result ${JSON.stringify(r)}`);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("discovery", () => {
  it("exposes exactly the four astrology tools", async () => {
    h = await connectServer();
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "calculate_natal_chart",
      "calculate_synastry",
      "get_transits_and_aspects",
      "resolve_birth_place",
    ]);
    for (const t of tools) {
      expect(t.description, `${t.name} needs a description for the agent`).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
    }
  });

  // Tool-preference nudge (2026-09-18): hosts like Grok / ChatGPT / Gemini decide
  // on their own whether to call a connector. Without an explicit "use these
  // tools whenever a birth date / horoscope / natal chart comes up — never
  // compute or web-search positions yourself" directive in the server
  // instructions AND in every tool description, Grok answered a natal-chart
  // request from web search and never touched the MCP (real user report).
  it("server instructions tell the host WHEN to use the tools and forbid guessing", async () => {
    h = await connectServer();
    const instructions = h.client.getInstructions() ?? "";
    // Triggers: any of these topics must route to the tools, Stellara named or not.
    for (const trigger of ["natal", "horoscope", "transit", "synastry", "birth date", "birth time", "birth place"]) {
      expect(instructions.toLowerCase(), `instructions must mention "${trigger}"`).toContain(trigger);
    }
    expect(instructions).toMatch(/even (when|if) the user does not mention Stellara/i);
    // The directive itself: never compute / never web-search.
    expect(instructions).toMatch(/never compute/i);
    expect(instructions).toMatch(/web[- ]search/i);
    // Workflow order: resolve_birth_place first, then the chart tools.
    expect(instructions.indexOf("resolve_birth_place")).toBeGreaterThan(-1);
    expect(instructions.indexOf("resolve_birth_place")).toBeLessThan(instructions.indexOf("calculate_natal_chart"));
    // Russian trigger words too — the bulk of the current audience writes Russian prompts.
    for (const trigger of ["гороскоп", "натальн"]) {
      expect(instructions.toLowerCase(), `instructions must mention "${trigger}"`).toContain(trigger);
    }
  });

  it("every tool description starts with a 'use this tool whenever…' directive and forbids self-computation", async () => {
    h = await connectServer();
    const { tools } = await h.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    for (const [name, description] of Object.entries(byName)) {
      expect(description, `${name}: must open with the when-to-use directive`).toMatch(/^(Call this FIRST|Use this tool) (whenever|for ANY)/);
      expect(description, `${name}: must forbid computing / guessing / web-searching`).toMatch(/never (compute|estimate|guess)/i);
    }
    expect(byName.resolve_birth_place).toMatch(/^Call this FIRST/);
    expect(byName.calculate_natal_chart).toMatch(/natal|birth chart|horoscope/i);
    expect(byName.get_transits_and_aspects).toMatch(/today|this week|forecast/i);
    expect(byName.calculate_synastry).toMatch(/compatibility|relationship/i);
  });

  it("natal tool schema requires birth_datetime, latitude, longitude", async () => {
    h = await connectServer();
    const { tools } = await h.client.listTools();
    const natal = tools.find((t) => t.name === "calculate_natal_chart")!;
    expect(natal.inputSchema.required).toEqual(
      expect.arrayContaining(["birth_datetime", "latitude", "longitude"]),
    );
    const props = natal.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.house_system?.enum).toEqual(expect.arrayContaining(["placidus", "whole_sign", "koch"]));
  });

  it("exposes the astrologer_system_prompt and collect_birth_profile prompts", async () => {
    h = await connectServer();
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["astrologer_system_prompt", "collect_birth_profile"]);
  });
});

// ---------------------------------------------------------------------------
// resolve_birth_place
// ---------------------------------------------------------------------------

describe("resolve_birth_place", () => {
  const RESOLVED = {
    query: "Warsaw",
    display_name: "Warszawa, Polska",
    latitude: 52.2297,
    longitude: 21.0122,
    timezone: "Europe/Warsaw",
    local_datetime: "1990-05-17T14:30:00",
    utc_offset: "+02:00",
    birth_datetime: "1990-05-17T14:30:00+02:00",
    birth_datetime_utc: "1990-05-17T12:30:00Z",
    time_assumed_noon: false,
    local_time_ambiguity: "none",
    age_years: 36,
    source: "nominatim",
  };

  it("POSTs place + naive local time to <base>/resolve-place and returns the backend JSON", async () => {
    h = await connectServer({ fetchImpl: fetchStub(200, RESOLVED) });
    const result = await h.client.callTool({
      name: "resolve_birth_place",
      arguments: { place: "Warsaw", local_datetime: "1990-05-17T14:30" },
    });
    const req = requestOf(h.fetchMock);
    expect(req.url).toBe("https://api.example.test/v1/astrology/resolve-place");
    expect(req.method).toBe("POST");
    expect(req.headers["x-api-key"]).toBe("sk_test_abc");
    expect(req.body).toEqual({ place: "Warsaw", local_datetime: "1990-05-17T14:30" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(RESOLVED);
  });

  it("works with a place only (no local_datetime key sent)", async () => {
    h = await connectServer({ fetchImpl: fetchStub(200, { ...RESOLVED, birth_datetime: null }) });
    await h.client.callTool({ name: "resolve_birth_place", arguments: { place: "Warsaw" } });
    expect(requestOf(h.fetchMock).body).toEqual({ place: "Warsaw" });
  });

  it.each([
    ["date only", "1990-05-17"],
    ["space separator", "1990-05-17 14:30"],
    ["with seconds", "1990-05-17T14:30:45"],
  ])("accepts naive local time: %s", async (_label, value) => {
    h = await connectServer({ fetchImpl: fetchStub(200, RESOLVED) });
    const result = await h.client.callTool({
      name: "resolve_birth_place",
      arguments: { place: "Warsaw", local_datetime: value },
    });
    expect(result.isError).toBeFalsy();
    expect(requestOf(h.fetchMock).body).toMatchObject({ local_datetime: value });
  });

  it.each([
    ["place too short", { place: "W" }, /place/i],
    ["missing place", { local_datetime: "1990-05-17T14:30" }, /place/i],
    ["offset given (agent must pass LOCAL time)", { place: "Warsaw", local_datetime: "1990-05-17T14:30:00+02:00" }, /local_datetime/i],
    ["Z given", { place: "Warsaw", local_datetime: "1990-05-17T14:30:00Z" }, /local_datetime/i],
    ["dd.mm.yyyy", { place: "Warsaw", local_datetime: "17.05.1990 14:30" }, /local_datetime/i],
  ])("rejects invalid input before any network call: %s", async (_label, args, pattern) => {
    h = await connectServer({ fetchImpl: fetchStub(200, RESOLVED) });
    const msg = await rejectionMessage(h.client.callTool({ name: "resolve_birth_place", arguments: args }));
    expect(msg).toMatch(pattern);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("404 → 'place not found' guidance for the agent", async () => {
    h = await connectServer({ fetchImpl: fetchStub(404, { detail: "PLACE_NOT_FOUND" }) });
    const result = await h.client.callTool({ name: "resolve_birth_place", arguments: { place: "Xyznowhere" } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/not found/i);
    expect(resultText(result)).toMatch(/larger|nearest|country/i);
  });

  it("502 from the geocoder → retry guidance, not 'place does not exist'", async () => {
    h = await connectServer({ fetchImpl: fetchStub(502, { detail: "GEOCODER_UNAVAILABLE" }) });
    const result = await h.client.callTool({ name: "resolve_birth_place", arguments: { place: "Warsaw" } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/retry|again/i);
    expect(resultText(result)).not.toMatch(/not found/i);
  });

  it("without STELLARA_API_KEY returns the key help", async () => {
    h = await connectServer({ env: { STELLARA_API_BASE_URL: TEST_ENV.STELLARA_API_BASE_URL } });
    const result = await h.client.callTool({ name: "resolve_birth_place", arguments: { place: "Warsaw" } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("STELLARA_API_KEY");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// calculate_natal_chart
// ---------------------------------------------------------------------------

describe("calculate_natal_chart", () => {
  it("POSTs to <base>/natal with the API key and returns the backend JSON verbatim", async () => {
    h = await connectServer({ fetchImpl: fetchStub(200, NATAL_JSON) });
    const result = await h.client.callTool({ name: "calculate_natal_chart", arguments: EINSTEIN });

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const req = requestOf(h.fetchMock);
    expect(req.url).toBe("https://api.example.test/v1/astrology/natal");
    expect(req.method).toBe("POST");
    expect(req.headers["x-api-key"]).toBe("sk_test_abc");
    expect(req.headers["content-type"]).toMatch(/application\/json/);
    expect(req.headers["user-agent"]).toMatch(/^stellara-mcp\/\d+\.\d+\.\d+/);
    expect(req.body).toEqual({
      ...EINSTEIN,
      house_system: "placidus",
      include_minor_aspects: false,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(NATAL_JSON);
    expect(JSON.parse(resultText(result))).toEqual(NATAL_JSON);
  });

  it("passes house_system and include_minor_aspects through", async () => {
    h = await connectServer({ fetchImpl: fetchStub(200, NATAL_JSON) });
    await h.client.callTool({
      name: "calculate_natal_chart",
      arguments: { ...EINSTEIN, house_system: "whole_sign", include_minor_aspects: true },
    });
    expect(requestOf(h.fetchMock).body).toEqual({
      ...EINSTEIN,
      house_system: "whole_sign",
      include_minor_aspects: true,
    });
  });

  it.each([
    ["latitude out of range", { ...EINSTEIN, latitude: 91 }, /latitude/i],
    ["longitude out of range", { ...EINSTEIN, longitude: -181 }, /longitude/i],
    ["naive datetime (no timezone)", { ...EINSTEIN, birth_datetime: "1879-03-14T10:30:00" }, /birth_datetime/i],
    ["date only", { ...EINSTEIN, birth_datetime: "1879-03-14" }, /birth_datetime/i],
    ["unknown house system", { ...EINSTEIN, house_system: "vedic-magic" }, /house_system/i],
    ["missing longitude", { birth_datetime: EINSTEIN.birth_datetime, latitude: 1 }, /longitude/i],
  ])("rejects invalid input before any network call: %s", async (_label, args, pattern) => {
    h = await connectServer({ fetchImpl: fetchStub(200, NATAL_JSON) });
    const msg = await rejectionMessage(h.client.callTool({ name: "calculate_natal_chart", arguments: args }));
    expect(msg).toMatch(pattern);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("accepts an offset datetime like +01:00", async () => {
    h = await connectServer({ fetchImpl: fetchStub(200, NATAL_JSON) });
    const result = await h.client.callTool({
      name: "calculate_natal_chart",
      arguments: { ...EINSTEIN, birth_datetime: "1879-03-14T11:30:00+01:00" },
    });
    expect(result.isError).toBeFalsy();
    expect(requestOf(h.fetchMock).body).toMatchObject({ birth_datetime: "1879-03-14T11:30:00+01:00" });
  });
});

// ---------------------------------------------------------------------------
// get_transits_and_aspects
// ---------------------------------------------------------------------------

describe("get_transits_and_aspects", () => {
  const TRANSITS_JSON = { natal: NATAL_JSON, target_datetime_utc: "2026-09-16T12:00:00Z", transiting_planets: [], aspects_to_natal: [], meta: {} };

  it("POSTs natal + target_datetime to <base>/transits", async () => {
    h = await connectServer({ fetchImpl: fetchStub(200, TRANSITS_JSON) });
    const result = await h.client.callTool({
      name: "get_transits_and_aspects",
      arguments: { natal: EINSTEIN, target_datetime: "2026-09-16T12:00:00Z" },
    });
    const req = requestOf(h.fetchMock);
    expect(req.url).toBe("https://api.example.test/v1/astrology/transits");
    expect(req.body).toEqual({
      natal: { ...EINSTEIN, house_system: "placidus" },
      target_datetime: "2026-09-16T12:00:00Z",
      include_minor_aspects: false,
    });
    expect(result.structuredContent).toEqual(TRANSITS_JSON);
  });

  it("rejects a naive target_datetime", async () => {
    h = await connectServer({ fetchImpl: fetchStub(200, TRANSITS_JSON) });
    const msg = await rejectionMessage(
      h.client.callTool({
        name: "get_transits_and_aspects",
        arguments: { natal: EINSTEIN, target_datetime: "2026-09-16T12:00:00" },
      }),
    );
    expect(msg).toMatch(/target_datetime/i);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid nested natal", async () => {
    h = await connectServer({ fetchImpl: fetchStub(200, TRANSITS_JSON) });
    const msg = await rejectionMessage(
      h.client.callTool({
        name: "get_transits_and_aspects",
        arguments: { natal: { ...EINSTEIN, latitude: 100 }, target_datetime: "2026-09-16T12:00:00Z" },
      }),
    );
    expect(msg).toMatch(/latitude/i);
  });
});

// ---------------------------------------------------------------------------
// calculate_synastry
// ---------------------------------------------------------------------------

describe("calculate_synastry", () => {
  const SYN_JSON = { person_a: NATAL_JSON, person_b: NATAL_JSON, inter_aspects: [], house_overlays: { a_in_b_houses: [], b_in_a_houses: [] }, meta: {} };

  it("POSTs both people to <base>/synastry", async () => {
    h = await connectServer({ fetchImpl: fetchStub(200, SYN_JSON) });
    const result = await h.client.callTool({
      name: "calculate_synastry",
      arguments: { person_a: EINSTEIN, person_b: { ...DIANA, house_system: "koch" } },
    });
    const req = requestOf(h.fetchMock);
    expect(req.url).toBe("https://api.example.test/v1/astrology/synastry");
    expect(req.body).toEqual({
      person_a: { ...EINSTEIN, house_system: "placidus" },
      person_b: { ...DIANA, house_system: "koch" },
      include_minor_aspects: false,
    });
    expect(result.structuredContent).toEqual(SYN_JSON);
  });

  it("requires both people", async () => {
    h = await connectServer({ fetchImpl: fetchStub(200, SYN_JSON) });
    const msg = await rejectionMessage(
      h.client.callTool({ name: "calculate_synastry", arguments: { person_a: EINSTEIN } }),
    );
    expect(msg).toMatch(/person_b/i);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Configuration + error surfaces (shared by all tools)
// ---------------------------------------------------------------------------

const ALL_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["calculate_natal_chart", EINSTEIN],
  ["get_transits_and_aspects", { natal: EINSTEIN, target_datetime: "2026-09-16T12:00:00Z" }],
  ["calculate_synastry", { person_a: EINSTEIN, person_b: DIANA }],
];

describe("missing STELLARA_API_KEY", () => {
  it.each(ALL_TOOLS)("%s returns an actionable error and never calls the network", async (name, args) => {
    h = await connectServer({ env: { STELLARA_API_BASE_URL: TEST_ENV.STELLARA_API_BASE_URL } });
    const result = await h.client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("STELLARA_API_KEY");
    expect(text).toContain("natlex.it");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("backend error mapping", () => {
  it("401 → invalid key message with where to get one", async () => {
    h = await connectServer({ fetchImpl: fetchStub(401, { detail: "INVALID_API_KEY" }) });
    const result = await h.client.callTool({ name: "calculate_natal_chart", arguments: EINSTEIN });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toMatch(/STELLARA_API_KEY/);
    expect(text).toMatch(/invalid|rejected|revoked/i);
    expect(text).toContain("natlex.it");
  });

  it("429 → rate-limit message", async () => {
    h = await connectServer({ fetchImpl: fetchStub(429, { detail: "RATE_LIMITED" }) });
    const result = await h.client.callTool({ name: "calculate_natal_chart", arguments: EINSTEIN });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/rate limit/i);
  });

  it("429 + QUOTA_EXCEEDED → daily-quota message with upgrade link and reset time", async () => {
    const f = fetchStub(429, { detail: "QUOTA_EXCEEDED" });
    f.mockResolvedValue(
      new Response(JSON.stringify({ detail: "QUOTA_EXCEEDED" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "5400", "x-quota-limit": "50" },
      }),
    );
    h = await connectServer({ fetchImpl: f });
    const result = await h.client.callTool({ name: "calculate_natal_chart", arguments: EINSTEIN });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toMatch(/daily quota/i);
    expect(text).toContain("https://stellara.natlex.it/#api");
    expect(text).toContain("00:00 UTC");
    expect(text).toMatch(/90 min/); // 5400 s → "~90 min"
    expect(text).not.toMatch(/rate limit reached/i);
  });

  it("429 + QUOTA_EXCEEDED without Retry-After still tells the agent when it resets", async () => {
    h = await connectServer({ fetchImpl: fetchStub(429, { detail: "QUOTA_EXCEEDED" }) });
    const result = await h.client.callTool({ name: "resolve_birth_place", arguments: { place: "Warsaw" } });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toMatch(/daily quota/i);
    expect(text).toContain("00:00 UTC");
    expect(text).not.toMatch(/~\d+ min/);
  });

  it("422 → validation message that surfaces the backend detail", async () => {
    h = await connectServer({
      fetchImpl: fetchStub(422, { detail: [{ loc: ["body", "house_system"], msg: "UNKNOWN_HOUSE_SYSTEM" }] }),
    });
    const result = await h.client.callTool({ name: "calculate_natal_chart", arguments: EINSTEIN });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("UNKNOWN_HOUSE_SYSTEM");
  });

  it("500 → backend unavailable message with the status code", async () => {
    h = await connectServer({ fetchImpl: fetchStub(500, { detail: "boom" }) });
    const result = await h.client.callTool({ name: "calculate_natal_chart", arguments: EINSTEIN });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Stellara API/);
    expect(resultText(result)).toContain("500");
  });

  it("network failure → reachability message", async () => {
    const failing = fetchStub(200, {});
    failing.mockRejectedValue(new TypeError("fetch failed"));
    h = await connectServer({ fetchImpl: failing });
    const result = await h.client.callTool({ name: "calculate_natal_chart", arguments: EINSTEIN });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/reach|network/i);
  });

  it("timeout → timed-out message", async () => {
    h = await connectServer({ fetchImpl: hangingFetch(), timeoutMs: 30 });
    const result = await h.client.callTool({ name: "calculate_natal_chart", arguments: EINSTEIN });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/timed out/i);
  });

  it("non-JSON 200 body → treated as a backend error, not a crash", async () => {
    const html = new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
    const f = fetchStub(200, {});
    f.mockResolvedValue(html);
    h = await connectServer({ fetchImpl: f });
    const result = await h.client.callTool({ name: "calculate_natal_chart", arguments: EINSTEIN });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Stellara API/);
  });
});

describe("base URL handling", () => {
  it("strips a trailing slash before joining the endpoint", async () => {
    h = await connectServer({
      env: { STELLARA_API_KEY: "k", STELLARA_API_BASE_URL: "https://api.example.test/v1/astrology/" },
      fetchImpl: fetchStub(200, NATAL_JSON),
    });
    await h.client.callTool({ name: "calculate_natal_chart", arguments: EINSTEIN });
    expect(requestOf(h.fetchMock).url).toBe("https://api.example.test/v1/astrology/natal");
  });
});

// ---------------------------------------------------------------------------
// astrologer_system_prompt
// ---------------------------------------------------------------------------

describe("astrologer_system_prompt", () => {
  it("returns a single user message with the interpretation rules", async () => {
    h = await connectServer();
    // Prompts that declare (optional) arguments are fetched with an
    // `arguments` object by every MCP client; the SDK validates that
    // object, so `arguments: {}` is the canonical "no args" call.
    const { messages } = await h.client.getPrompt({ name: "astrologer_system_prompt", arguments: {} });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    const content = messages[0].content;
    expect(content.type).toBe("text");
    const text = (content as { text: string }).text;
    expect(text).toMatch(/Swiss Ephemeris/);
    expect(text).toMatch(/never (invent|guess)/i);
    expect(text).toMatch(/orb/i);
    expect(text).toMatch(/applying|separating/i);
    expect(text).toMatch(/calculate_natal_chart/);
    expect(text).toMatch(/get_transits_and_aspects/);
    expect(text).toMatch(/calculate_synastry/);
    expect(text).toMatch(/resolve_birth_place/);
    expect(text).toMatch(/collect_birth_profile/);
  });

  it("honours the language and focus arguments", async () => {
    h = await connectServer();
    const { messages } = await h.client.getPrompt({
      name: "astrologer_system_prompt",
      arguments: { language: "Russian", focus: "career and productivity" },
    });
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain("Russian");
    expect(text).toContain("career and productivity");
  });
});

// ---------------------------------------------------------------------------
// collect_birth_profile
// ---------------------------------------------------------------------------

describe("collect_birth_profile", () => {
  it("is a guided intake in a fixed order with required vs optional fields", async () => {
    h = await connectServer();
    const { messages } = await h.client.getPrompt({ name: "collect_birth_profile", arguments: {} });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    const text = (messages[0].content as { text: string }).text;

    // Required trio, asked first, in this order.
    const iDate = text.search(/date of birth/i);
    const iTime = text.search(/time of birth/i);
    const iPlace = text.search(/place of birth/i);
    const iCity = text.search(/Step 4 — Current place of residence/);
    const iName = text.search(/Step 5 — Name/);
    const iGender = text.search(/gender/i);
    expect(iDate).toBeGreaterThan(-1);
    expect(iTime).toBeGreaterThan(iDate);
    expect(iPlace).toBeGreaterThan(iTime);
    expect(iCity).toBeGreaterThan(iPlace);
    expect(iName).toBeGreaterThan(iCity);
    expect(iGender).toBeGreaterThan(iName);

    // Birth-time certainty buckets (mirrors the app's birth_time_certainty).
    // Time is required and must be asked for explicitly; "unknown" only after
    // the user confirms nobody knows it.
    expect(text).toMatch(/Step 2 — Time of birth \(required\)/);
    expect(text).toMatch(/exact/i);
    expect(text).toMatch(/approximate/i);
    expect(text).toMatch(/explicitly confirms that nobody knows/i);
    expect(text).toMatch(/unknown/i);
    expect(text).toMatch(/12:00/);
    expect(text).toMatch(/houses/i);
    // Residence: country + city / town / village (optional, but always asked).
    expect(text).toMatch(/country and\s+city, town or village/i);

    // Gender is optional and only matters for synastry; name is optional.
    expect(text).toMatch(/gender[^.]*optional/i);
    expect(text).toMatch(/synastry/i);
    expect(text).toMatch(/name[^.]*optional/i);

    // Resolves the place through the tool, computes age, asks to confirm.
    expect(text).toMatch(/resolve_birth_place/);
    expect(text).toMatch(/\bage\b/i);
    expect(text).toMatch(/confirm/i);
    // Privacy: nothing is stored server-side.
    expect(text).toMatch(/not stored|never stored|nothing is stored/i);
  });

  it("honours the language argument", async () => {
    h = await connectServer();
    const { messages } = await h.client.getPrompt({
      name: "collect_birth_profile",
      arguments: { language: "Russian" },
    });
    expect((messages[0].content as { text: string }).text).toContain("Russian");
  });
});
