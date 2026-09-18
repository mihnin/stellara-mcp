# Stellara MCP: Deterministic Swiss Ephemeris for AI Agents (Hermes, Claude, Grok)

**Give your AI agent a real astronomical calculator.** `stellara-mcp` is a tiny,
open-source [Model Context Protocol](https://modelcontextprotocol.io) server that
turns any MCP-capable agent — Claude.ai / Claude Desktop / Claude Code, ChatGPT, Codex,
Cursor, Windsurf, Gemini CLI, Grok, Hermes — into an astrologer that **never invents a
planetary position**. Connect by URL (no install) or run the package locally with an API key.

It exposes four tools backed by **Swiss Ephemeris** (the same engine professional
astrologers use) running in the Stellara cloud:

| Tool | What you get back (exact JSON) |
| --- | --- |
| `resolve_birth_place` | "Warsaw, 14:30" → latitude / longitude, IANA timezone and a tz-aware `birth_datetime` with the **historically correct UTC offset** (old DST rules, decree time), plus age and DST-ambiguity flags — so the agent never guesses coordinates or offsets |
| `calculate_natal_chart` | 14 points (Sun → Pluto, Chiron, Lilith, North/South Node) with sign, degree, absolute longitude, house, retrograde, speed, declination · 12 house cusps · Ascendant / MC / Descendant / IC · every major aspect with its **exact orb** and applying / separating |
| `get_transits_and_aspects` | Transiting positions at any moment · every transit-to-natal aspect (planets **and** angles) with orb and applying / separating · which natal house each transiting planet occupies |
| `calculate_synastry` | All inter-chart aspects between two people with exact orbs · house overlays (A's planets in B's houses and vice versa) |

Plus two MCP prompts: `collect_birth_profile`, a guided intake of the data every
reading depends on (date → time with certainty → place → optional city, name,
gender → confirmation card with age), and `astrologer_system_prompt`, which
switches the agent into a disciplined professional-astrologer style for
interpreting that JSON.

The server **does not interpret and does not call any LLM**. It is a proxy adapter:
numbers in, numbers out. Your agent does the reading; Swiss Ephemeris does the math.

---

## Why this exists: LLMs lie about natal charts

Ask a language model "where was my Moon on 17 May 1990 at 14:30 in Warsaw?" and it
will answer confidently — and, more often than not, wrongly. Ecliptic longitudes,
house cusps and aspect orbs are the output of numerical integration of planetary
motion plus spherical trigonometry for the local horizon. That is not something a
next-token predictor can do in its head. Typical failure modes:

- the Moon (13° per day) lands in the wrong sign;
- the Ascendant is guessed from the Sun sign, ignoring time and latitude;
- house cusps are fabricated or silently assume Equal houses;
- "Saturn square Sun" is asserted with no orb, or with an orb that does not exist;
- retrograde status is invented.

Every one of those errors poisons the whole interpretation that follows. A reading
built on a wrong Ascendant is worthless no matter how eloquent it is.

`stellara-mcp` fixes this at the root. The agent calls a tool; the tool returns
Swiss-Ephemeris-grade positions (sub-arcsecond precision, tropical zodiac, ten house
systems, exact orbs, applying/separating derived from real planetary speeds); the
agent interprets **only** that data. Deterministic senses, deterministic
calculator — the language model is left to do what it is actually good at.

---

## Quick start (1-click configs)

Two ways to connect:

- **Remote, no install** (Claude.ai, Claude Desktop, Claude Code, ChatGPT connectors,
  Grok, any client that takes an MCP URL): add a custom connector with the URL
  **`https://mcp.stellara.natlex.it/mcp`** and sign in with your Stellara account
  (the same account as the Stellara app; Free = 10 requests / day, Stellara Pro = 5 000).
  Claude: *Settings → Connectors → Add custom connector → paste the URL → Connect → sign in.*
  Claude Code: `claude mcp add --transport http stellara https://mcp.stellara.natlex.it/mcp`,
  then `/mcp` to sign in. Nothing to install, nothing to configure; tokens are short-lived
  and can be revoked from the app.
- **Local package + API key** (below): for servers, scripts, Cursor / Windsurf / Codex and
  anyone who prefers a key. Get one at
  **[stellara.natlex.it/#api](https://stellara.natlex.it/#api)** — Free (5 requests / day) or
  Stellara API Pro (5 000 / day, $9 / month), delivered by e-mail within a minute. Then
  pick your client.

> The package runs on Node.js ≥ 18.17 and is launched with `npx`, so nothing to
> install globally. All configs below are the same three lines: command, args, env.

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "stellara": {
      "command": "npx",
      "args": ["-y", "stellara-mcp"],
      "env": {
        "STELLARA_API_KEY": "sk_stellara_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The three tools appear under the 🔌 icon; the
`astrologer_system_prompt` prompt appears in the prompts (+) menu.

### Hermes Agent Desktop

Add the same block to `~/.hermes/config.json`:

```json
{
  "mcpServers": {
    "stellara": {
      "command": "npx",
      "args": ["-y", "stellara-mcp"],
      "env": {
        "STELLARA_API_KEY": "sk_stellara_your_key_here"
      }
    }
  }
}
```

Hermes discovers the tools on next launch. If your Hermes build uses a different
top-level key for MCP servers, keep the `command` / `args` / `env` triple as is —
it is the standard stdio launch spec.

### Cursor / Windsurf

Cursor: **Settings → MCP → Add new global MCP server** (or `.cursor/mcp.json` in a
project). Windsurf: **Settings → Cascade → MCP servers** (or
`~/.codeium/windsurf/mcp_config.json`). Both take the identical JSON:

```json
{
  "mcpServers": {
    "stellara": {
      "command": "npx",
      "args": ["-y", "stellara-mcp"],
      "env": {
        "STELLARA_API_KEY": "sk_stellara_your_key_here"
      }
    }
  }
}
```

### Any other MCP client (Grok bridges, Continue, Zed, custom agents)

Launch `npx -y stellara-mcp` as a **stdio** server with the environment variable
`STELLARA_API_KEY` set. That is the whole integration surface.

### From a local clone (for development)

```bash
git clone https://github.com/mihnin/stellara-mcp.git
cd stellara-mcp
npm install && npm run build
```

then use `"command": "node", "args": ["/absolute/path/to/stellara-mcp/dist/index.js"]`
in any of the configs above.

---

## Example conversation

> **User:** Build my natal chart — I was born on 17 May 1990 at 14:30 in Warsaw —
> and tell me why work feels so heavy today.
>
> **Agent** *(loads `astrologer_system_prompt`, asks whether 14:30 is exact or
> approximate, calls `resolve_birth_place("Warsaw, Poland", "1990-05-17T14:30")` →
> 52.23 / 21.01, Europe/Warsaw, `1990-05-17T14:30:00+02:00`, then
> `calculate_natal_chart` with those values, then `get_transits_and_aspects` for today)*
>
> Your chart is built from Swiss Ephemeris positions, so let's start with what's
> actually there. Sun at 26°14' Taurus in the 9th house, Moon at 3°52' Capricorn in
> the 4th, Ascendant 8°41' Virgo. The tightest natal aspect is Saturn conjunct
> Neptune (orb 0.6°) sitting in your 5th house — a lifelong tension between structure
> and drift in creative work.
>
> Why today is heavy: transiting Saturn is squaring your natal Sun with an orb of
> 1.2° and it is **applying**, so the pressure is still building toward exact in
> about two weeks. Saturn squares to the Sun feel like carrying a backpack of
> obligations — output is fine, but everything costs more effort. At the same time
> transiting Mars is passing through your natal 6th house of daily work
> (Aquarius), conjunct your natal Mercury with a 0.4° orb: fast, irritable, prone to
> arguing with tools and colleagues.
>
> Practical read: this is a "finish, don't start" window. Close the two tasks with
> deadlines, defer the brainstorming to after the Saturn square separates, and
> don't read the Mars–Mercury irritability as a sign that the job is wrong. If you
> can, I'd like your birth time to the minute — the Ascendant at 8° Virgo is close
> to a sign boundary, and the house placements above depend on it.

Every degree, orb and "applying" in that answer came from a tool result; the
interpretation is the agent's. That separation is the entire point.

---

## Tool reference

Chart tools take datetimes as **ISO-8601 with a timezone** (`1990-05-17T14:30:00+02:00`
or `...Z`); naive values are rejected before any network call. Coordinates are
decimal degrees (north / east positive). The intended flow is `resolve_birth_place`
first — it produces exactly those values from what the user actually says.

### `resolve_birth_place`

| Input | Type | Notes |
| --- | --- | --- |
| `place` | string | Free text, any language: `Warsaw`, `Варшава`, `Springfield, Illinois, USA` |
| `local_datetime` | string (optional) | **Local wall-clock time without an offset**: `1990-05-17T14:30`, or `1990-05-17` if the time is unknown (12:00 assumed and flagged) |

Output:

```json
{
  "query": "Warsaw", "display_name": "Warszawa, województwo mazowieckie, Polska",
  "latitude": 52.2333742, "longitude": 21.0711489, "timezone": "Europe/Warsaw",
  "local_datetime": "1990-05-17T14:30:00", "utc_offset": "+02:00",
  "birth_datetime": "1990-05-17T14:30:00+02:00", "birth_datetime_utc": "1990-05-17T12:30:00Z",
  "time_assumed_noon": false, "local_time_ambiguity": "none", "age_years": 36,
  "source": "nominatim"
}
```

`birth_datetime`, `latitude` and `longitude` go straight into the chart tools.
`local_time_ambiguity` is `ambiguous_dst_fallback` when the wall time happened
twice (autumn clock change) and `nonexistent_dst_gap` when the clocks skipped it —
the agent should ask which one the user means. Offsets come from the IANA tz
database, so 1985 Moscow resolves to +04:00 and 2015 Moscow to +03:00. Errors:
`PLACE_NOT_FOUND` (try a larger nearby city / add the country) and
`GEOCODER_UNAVAILABLE` (transient — retry). Geocoding uses OpenStreetMap
Nominatim; nothing about the request is stored.

### `calculate_natal_chart`

| Input | Type | Notes |
| --- | --- | --- |
| `birth_datetime` | string | ISO-8601 with tz |
| `latitude` | number | −90 … 90 |
| `longitude` | number | −180 … 180 |
| `house_system` | enum | `placidus` (default), `koch`, `porphyry`, `regiomontanus`, `campanus`, `equal`, `whole_sign`, `topocentric`, `morinus`, `alcabitius` |
| `include_minor_aspects` | boolean | default `false` — majors only (conjunction 10°, opposition 10°, trine 8°, square 8°, sextile 6°) |

Output (abridged):

```json
{
  "input": { "birth_datetime_utc": "1879-03-14T10:30:00Z", "latitude": 48.4011, "longitude": 9.9876, "house_system": "placidus" },
  "planets": [
    { "name": "Sun", "sign": "Pisces", "degree": 23.498749, "absolute_longitude": 353.498749,
      "house": 10, "retrograde": false, "speed": 0.995959, "declination": -2.585261 }
  ],
  "houses": [ { "house": 1, "sign": "Cancer", "degree": 7.4423, "absolute_longitude": 97.4423 } ],
  "angles": { "ascendant": {...}, "midheaven": {...}, "descendant": {...}, "imum_coeli": {...} },
  "aspects": [
    { "point_a": "Sun", "point_b": "Mercury", "aspect": "conjunction", "exact_degrees": 0, "orb": 9.627514, "movement": "separating" }
  ],
  "meta": { "engine": "Swiss Ephemeris (kerykeion 5.12.7)", "zodiac": "tropical", "house_system": "placidus", "orbs": {...}, "time_resolution": "minute" }
}
```

### `get_transits_and_aspects`

| Input | Type |
| --- | --- |
| `natal` | object — same fields as `calculate_natal_chart` |
| `target_datetime` | string — ISO-8601 with tz |
| `include_minor_aspects` | boolean |

Returns `natal` (the full chart above), `target_datetime_utc`, `transiting_planets`
(same point shape plus `natal_house`), and `aspects_to_natal`:

```json
{ "transiting": "Saturn", "natal": "Sun", "aspect": "square", "exact_degrees": 90, "orb": 1.21, "movement": "applying" }
```

`movement` is computed with the natal point held fixed — only the transiting body
moves — using the real planetary speed for that instant.

### `calculate_synastry`

| Input | Type |
| --- | --- |
| `person_a`, `person_b` | object — same fields as `calculate_natal_chart` |
| `include_minor_aspects` | boolean |

Returns both full charts, `inter_aspects` (`point_a` belongs to A, `point_b` to B,
with `orb`), and `house_overlays` (`a_in_b_houses`, `b_in_a_houses`).

### Prompt: `collect_birth_profile`

Argument (optional): `language`. A fixed-order intake the agent walks through
before any chart: **1** date of birth → **2** time of birth with its certainty
(exact / approximate / unknown → 12:00 and no house interpretation) → **3** place
of birth, resolved through `resolve_birth_place` and confirmed with the user →
**4** current city (optional, only to interpret "today" in local time) → **5**
name (optional) → **6** gender (optional, asked only for synastry) → **7** a
confirmation card with the resolved coordinates, timezone, `birth_datetime` and
age. Mirrors the profile the Stellara app collects, minus anything the
calculation does not need.

### Prompt: `astrologer_system_prompt`

Arguments (both optional): `language` — the language to answer in; `focus` — the
user's current concern. The prompt carries the same intake rules, mandates
`resolve_birth_place` for coordinates and offsets, and instructs the agent to use
tool JSON as the only source of positions, cite orbs, respect applying/separating,
flag unreliable houses when the birth time is unknown, and keep interpretation
separate from calculation.

---

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `STELLARA_API_KEY` | **yes** | — | Access key, sent as `X-API-Key`. Request one at [stellara.natlex.it/#api](https://stellara.natlex.it/#api). Without it every tool returns a clear error that says where to get one. |
| `STELLARA_API_BASE_URL` | no | `https://api.stellara.natlex.it/api/v1/astrology` | Point at a self-hosted Stellara backend (the raw Cloud Run URL `https://stellara-api-923668916124.us-central1.run.app/api/v1/astrology` also works) |
| `STELLARA_TIMEOUT_MS` | no | `15000` | Per-request timeout |

Errors are returned as MCP tool errors with an actionable message — invalid or
revoked key (401), place not found (404), rate limit (429, 60 requests / minute /
IP; 20 for `resolve_birth_place`), **daily quota used up** (429 with
`QUOTA_EXCEEDED` — the message tells the agent when the quota resets at 00:00 UTC
and where to upgrade the key), backend validation detail (422), geocoder or
backend outage (5xx), network failure, timeout. The server never
crashes at launch because of configuration; it explains the problem when a tool is
called, which is what desktop agents handle best.

Keys come in tiers: **free** (5 requests / day — enough to try every tool) and **Stellara API Pro**
(5 000 / day, $9 / month) — see [stellara.natlex.it/#api](https://stellara.natlex.it/#api).

---

## Remote mode (Streamable HTTP)

The same package also runs as an HTTP service — `node dist/remote.js` — which is what
`https://mcp.stellara.natlex.it/mcp` is (Cloud Run, stateless, one `McpServer` per
request). It is an OAuth 2.1 *resource server*: `GET /.well-known/oauth-protected-resource/mcp`
points clients at the authorization server (the Stellara backend, `https://api.stellara.natlex.it`,
DCR + CIMD + PKCE S256), an unauthenticated `POST /mcp` answers `401` with
`WWW-Authenticate: Bearer … resource_metadata="…"`, and a valid token — an OAuth access
token or an `sk_stellara_` key sent as `Authorization: Bearer` — is forwarded to the API,
which enforces the daily quota. `GET /health` for monitoring; `GET /mcp` is 405 (no SSE
stream, no sessions).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `JWT_SECRET` | **yes** | — | HS256 secret shared with the authorization server (the service refuses to start without it) |
| `MCP_PUBLIC_URL` | no | `https://mcp.stellara.natlex.it` | Public origin; `<origin>/mcp` is the token audience (RFC 8707 `resource`) |
| `OAUTH_ISSUER` | no | `https://api.stellara.natlex.it` | Authorization server (RFC 8414 issuer) |
| `PORT` | no | `8080` | Listen port (Cloud Run sets it) |
| `GLAMA_CLAIM_TOKEN` | no | — | When set, `GET /.well-known/glama.json` publishes the Glama connector ownership claim (public by design) |
| `STELLARA_API_BASE_URL`, `STELLARA_TIMEOUT_MS` | no | as above | Same as stdio mode |

---

## Self-hosting the calculator

The calculator behind the tools is the Stellara API (FastAPI + kerykeion / pyswisseph),
hosted at `https://api.stellara.natlex.it`. The MCP server itself is a thin, stateless
adapter: point `STELLARA_API_BASE_URL` at another instance of the API and everything
else stays the same. The backend is not published as open source; for a private
deployment write to info@natlex.it.

---

## Guides

- [docs/USAGE.ru.md](docs/USAGE.ru.md) — инструкция для пользователей (на русском): установка в Claude Desktop / Cursor / Hermes, получение ключа, примеры диалогов, что делать при ошибках.
- Maintainer runbook (npm release, official MCP Registry, catalogues, remote-service deploy) lives in the private Stellara monorepo (`docs/PUBLISHING.md` there) and is not published.

## Source

This repository is the public source of the npm package and the remote service. Day-to-day
development happens in the private Stellara monorepo; every release is synced here as a
single commit (`sync: stellara-mcp <version>`). Issues are welcome here; pull requests are
merged into the monorepo and land here with the next sync.

## Development

```bash
npm install
npm test          # vitest: every behavioural test drives the real MCP protocol
npm run build     # tsc → dist/
npm start         # runs the stdio server
```

Tests connect an MCP `Client` to the server over an in-memory transport, stub
`fetch`, and assert exactly what a desktop agent would observe: tool discovery,
schema rejection before any network call, request shape (URL, headers, body), the
JSON passthrough, every error mapping, timeouts and the prompt text.

## License

MIT © [Natlex](https://www.natlex.it/). Swiss Ephemeris is © Astrodienst AG and is
used on the server side under its license via [kerykeion](https://github.com/g-battaglia/kerykeion).
