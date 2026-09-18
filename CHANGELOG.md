# Changelog

All notable changes to `stellara-mcp`. The package follows semver; the remote
service at `https://mcp.stellara.natlex.it/mcp` is deployed from the same
source and reports the same version in `serverInfo`.

## 0.2.2 — 2026-09-19

### Added
- Remote service: `GET /.well-known/glama.json` publishes the Glama connector
  ownership claim when `GLAMA_CLAIM_TOKEN` is set (Glama lists the remote as
  `it.natlex/stellara-mcp` from the official registry; the claim unlocks health
  checks, analytics and listing edits).

### Changed
- The source is now public at https://github.com/mihnin/stellara-mcp (a snapshot
  mirror of the package, synced at every release). `package.json` `repository` /
  `homepage` / `bugs`, `server.json` `repository`, the docs links and the
  metadata `service_documentation` URLs point there instead of the private
  monorepo, which resolved to a 404 for everyone else.

## 0.2.1 — 2026-09-18

### Changed
- Server `instructions` and all four tool descriptions now tell the host model
  WHEN to use the tools — any natal chart / horoscope / transits / synastry
  request, or any birth date + time + place in the conversation, even when
  Stellara is not named (English + Russian triggers) — and forbid computing or
  web-searching positions, coordinates and UTC offsets instead of calling them.
  Hosts that pick connectors on their own (Grok, ChatGPT, Gemini) used to answer
  from web search and never call the server. The remote service picks this up
  on deploy; the Gemini CLI extension carries the same rule in `GEMINI.md`.

## 0.2.0 — 2026-09-18

### Added
- **Remote mode (Streamable HTTP)** — `node dist/remote.js`, live at
  `https://mcp.stellara.natlex.it/mcp`. Add it as a custom connector in
  Claude.ai / Claude Desktop / Claude Code (`claude mcp add --transport http`),
  ChatGPT developer-mode connectors, Grok, Cursor or any remote-MCP client and
  sign in with your Stellara account — nothing to install, no key to manage.
  OAuth 2.1 (DCR + CIMD, PKCE S256) against the Stellara backend; `sk_stellara_`
  API keys are accepted as bearer tokens too.
- Daily-quota errors (`429 QUOTA_EXCEEDED`) are reported as `quota_exceeded`
  with the reset time (00:00 UTC) and, for signed-in users, a pointer to
  Stellara Pro; API-key users are pointed at the upgrade page.
- `collect_birth_profile` / `astrologer_system_prompt`: birth time is now
  required (with exact / approximate certainty) and the intake asks for the
  current place of residence (country + city/town/village).

### Changed
- Free API keys are self-service (e-mailed from https://stellara.natlex.it/#api),
  quota 5 requests/day; **Stellara API Pro** (5 000/day, $9/month) via Stripe.
- `express` and `jose` are declared as direct dependencies (used by the remote
  entry point; both already shipped with the MCP SDK).

## 0.1.1 — 2026-09-17

- `resolve_birth_place` tool + `collect_birth_profile` prompt (birth-profile intake
  with historically correct UTC offsets).
- Default API host `https://api.stellara.natlex.it`.

## 0.1.0 — 2026-09-17

- Initial release: `calculate_natal_chart`, `get_transits_and_aspects`,
  `calculate_synastry`, `astrologer_system_prompt`.
