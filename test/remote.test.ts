/**
 * Behavioural tests for the remote (Streamable HTTP) mode — PR 4 of
 * docs/MCP_PHASE2_PLAN.ru.md.
 *
 * The express app from `src/remote.ts` is started in-process on a random
 * port and driven the way Claude.ai / Claude Desktop / MCP Inspector drive
 * it: plain HTTP for the discovery documents and the auth challenge, the
 * real SDK `Client` + `StreamableHTTPClientTransport` for the protocol.
 * The Stellara backend is a fetch stub, so what we assert about outbound
 * requests is exactly what api.stellara.natlex.it would receive.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { readRemoteConfig, type RemoteConfig } from "../src/config.js";
import { createRemoteApp } from "../src/remote.js";
import { VERSION } from "../src/version.js";
import { fetchStub, requestOf, resultText, type FetchMock } from "./helpers.js";

const REMOTE_ENV = {
  JWT_SECRET: "test-secret-key-for-ci-runs-only",
  OAUTH_ISSUER: "https://api.test",
  MCP_PUBLIC_URL: "https://mcp.test",
  STELLARA_API_BASE_URL: "https://api.test/api/v1/astrology",
};
const RESOURCE = "https://mcp.test/mcp";
const API_KEY = "sk_stellara_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno";
const PLACE_JSON = { place: "Warsaw", latitude: 52.2297, longitude: 21.0122, timezone: "Europe/Warsaw", birth_datetime: "1990-05-17T14:30:00+02:00" };

let server: Server | undefined;
let baseUrl = "";
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start(options: { fetchImpl?: FetchMock; env?: Record<string, string> } = {}): Promise<{ fetchMock: FetchMock; config: RemoteConfig }> {
  const config = readRemoteConfig(options.env ?? REMOTE_ENV);
  const fetchMock = options.fetchImpl ?? fetchStub(200, PLACE_JSON);
  const app = createRemoteApp({ config, fetchImpl: fetchMock });
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { fetchMock, config };
}

interface Claims {
  sub?: string;
  aud?: string;
  iss?: string;
  typ?: string;
  scope?: string;
  client_id?: string;
  exp?: number;
}

async function mint(over: Claims = {}, secret = REMOTE_ENV.JWT_SECRET): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Claims = { sub: "42", aud: RESOURCE, iss: REMOTE_ENV.OAUTH_ISSUER, typ: "mcp", scope: "mcp", client_id: "mcp_test", ...over };
  const jwt = new SignJWT({ typ: claims.typ, scope: claims.scope, client_id: claims.client_id, type: "mcp" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now - 5)
    .setExpirationTime(claims.exp ?? now + 1800)
    .setJti("jti-" + Math.random().toString(36).slice(2));
  if (claims.sub !== undefined) jwt.setSubject(claims.sub);
  if (claims.aud !== undefined) jwt.setAudience(claims.aud);
  if (claims.iss !== undefined) jwt.setIssuer(claims.iss);
  return jwt.sign(new TextEncoder().encode(secret));
}

async function connect(token: string): Promise<Client> {
  client = new Client({ name: "remote-tests", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
});

async function postMcp(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: initializeBody,
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("readRemoteConfig", () => {
  it("applies defaults and normalises trailing slashes", () => {
    const c = readRemoteConfig({ JWT_SECRET: "s", MCP_PUBLIC_URL: "https://mcp.test/", OAUTH_ISSUER: "https://api.test//" });
    expect(c.publicUrl).toBe("https://mcp.test");
    expect(c.resourceUrl).toBe("https://mcp.test/mcp");
    expect(c.issuer).toBe("https://api.test");
    expect(c.port).toBe(8080);
    expect(c.baseUrl).toBe("https://api.stellara.natlex.it/api/v1/astrology");
    expect(c.jwtSecret).toBe("s");
  });

  it("has production defaults for the public URL and issuer", () => {
    const c = readRemoteConfig({ JWT_SECRET: "s" });
    expect(c.publicUrl).toBe("https://mcp.stellara.natlex.it");
    expect(c.issuer).toBe("https://api.stellara.natlex.it");
  });

  it("reads PORT and refuses to start without JWT_SECRET", () => {
    expect(readRemoteConfig({ JWT_SECRET: "s", PORT: "9090" }).port).toBe(9090);
    expect(readRemoteConfig({ JWT_SECRET: "s", PORT: "nope" }).port).toBe(8080);
    expect(() => readRemoteConfig({})).toThrow(/JWT_SECRET/);
    expect(() => readRemoteConfig({ JWT_SECRET: "   " })).toThrow(/JWT_SECRET/);
  });
});

// ---------------------------------------------------------------------------
// Discovery + health
// ---------------------------------------------------------------------------

describe("discovery", () => {
  it("serves the protected-resource metadata at the path-specific and root URLs", async () => {
    await start();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const r = await fetch(`${baseUrl}${path}`, { headers: { origin: "http://localhost:6274" } });
      expect(r.status, path).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      const doc = (await r.json()) as Record<string, unknown>;
      expect(doc.resource).toBe(RESOURCE);
      expect(doc.authorization_servers).toEqual([REMOTE_ENV.OAUTH_ISSUER]);
      expect(doc.scopes_supported).toEqual(["mcp"]);
      expect(doc.bearer_methods_supported).toEqual(["header"]);
      expect(doc.resource_name).toBe("Stellara MCP");
    }
  });

  it("mirrors the authorization-server metadata for clients that look on the MCP host", async () => {
    await start();
    const r = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(r.status).toBe(200);
    const doc = (await r.json()) as Record<string, unknown>;
    expect(doc.issuer).toBe(REMOTE_ENV.OAUTH_ISSUER);
    expect(doc.authorization_endpoint).toBe("https://api.test/oauth/authorize");
    expect(doc.token_endpoint).toBe("https://api.test/oauth/token");
    expect(doc.registration_endpoint).toBe("https://api.test/oauth/register");
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(doc.client_id_metadata_document_supported).toBe(true);
  });

  it("answers /health (and /healthz locally) and 404s unknown paths as JSON", async () => {
    await start();
    for (const path of ["/health", "/healthz"]) {
      const ok = await fetch(`${baseUrl}${path}`);
      expect(ok.status, path).toBe(200);
      expect(await ok.json()).toEqual({ status: "ok", service: "stellara-mcp", version: VERSION });
    }
    const missing = await fetch(`${baseUrl}/nope`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("not_found");
  });

  // Glama connector claim (https://glama.ai/mcp/connectors/it.natlex/stellara-mcp → Admin):
  // Glama re-checks `/.well-known/glama.json` on the connector's origin periodically,
  // so the file is served by the remote service itself from an env var — no static
  // hosting to keep alive, and each app in the playbook gets its own token.
  it("serves the Glama ownership claim at /.well-known/glama.json only when GLAMA_CLAIM_TOKEN is set", async () => {
    await start({ env: { ...REMOTE_ENV, GLAMA_CLAIM_TOKEN: " glama_claim_test123 " } });
    const res = await fetch(`${baseUrl}/.well-known/glama.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ $schema: "https://glama.ai/mcp/schemas/connector.json", claim: "glama_claim_test123" });
  });

  it("404s /.well-known/glama.json when no claim token is configured", async () => {
    await start();
    const res = await fetch(`${baseUrl}/.well-known/glama.json`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("only accepts POST on /mcp (stateless — no SSE stream, no sessions)", async () => {
    await start();
    const get = await fetch(`${baseUrl}/mcp`, { headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST, OPTIONS");
    const del = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
    expect(del.status).toBe(405);
    const options = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS", headers: { origin: "https://claude.ai" } });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-methods")).toContain("POST");
    expect(options.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
  });
});

// ---------------------------------------------------------------------------
// Bearer auth challenge
// ---------------------------------------------------------------------------

describe("auth challenge", () => {
  it("401 + WWW-Authenticate with resource_metadata when no token is sent", async () => {
    await start();
    const r = await postMcp();
    expect(r.status).toBe(401);
    const www = r.headers.get("www-authenticate") ?? "";
    expect(www).toMatch(/^Bearer /);
    expect(www).toContain('error="invalid_token"');
    expect(www).toContain('resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"');
    expect(www).toContain('scope="mcp"');
    expect(((await r.json()) as { error: string }).error).toBe("invalid_token");
    expect(r.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("www-authenticate");
  });

  it("rejects expired, foreign-audience, foreign-issuer, wrong-secret and non-MCP tokens with 401", async () => {
    await start();
    const now = Math.floor(Date.now() / 1000);
    const bad: Array<[string, Promise<string>]> = [
      ["expired", mint({ exp: now - 10 })],
      ["wrong aud", mint({ aud: "https://other.test/mcp" })],
      ["wrong iss", mint({ iss: "https://evil.test" })],
      ["wrong secret", mint({}, "another-secret")],
      ["typ missing", mint({ typ: undefined })],
      ["typ=access", mint({ typ: "access" })],
      ["no sub", mint({ sub: undefined })],
      ["garbage", Promise.resolve("not.a.jwt")],
    ];
    for (const [label, tokenP] of bad) {
      const r = await postMcp({ authorization: `Bearer ${await tokenP}` });
      expect(r.status, label).toBe(401);
      expect(r.headers.get("www-authenticate"), label).toContain("resource_metadata=");
    }
  });

  it("refuses a token without the mcp scope with 403 insufficient_scope", async () => {
    await start();
    const r = await postMcp({ authorization: `Bearer ${await mint({ scope: "other" })}` });
    expect(r.status).toBe(403);
    expect(r.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("rejects a non-bearer scheme and a bearer token in the query string", async () => {
    await start();
    expect((await postMcp({ authorization: `Basic ${Buffer.from("a:b").toString("base64")}` })).status).toBe(401);
    const r = await fetch(`${baseUrl}/mcp?access_token=${await mint()}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: initializeBody,
    });
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The protocol over HTTP with a valid token
// ---------------------------------------------------------------------------

describe("MCP over Streamable HTTP", () => {
  it("lists the 4 tools and 2 prompts with an OAuth access token", async () => {
    await start();
    const c = await connect(await mint());
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["calculate_natal_chart", "calculate_synastry", "get_transits_and_aspects", "resolve_birth_place"]);
    const prompts = (await c.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["astrologer_system_prompt", "collect_birth_profile"]);
  });

  it("forwards the OAuth token to the backend as Authorization: Bearer (never as X-API-Key)", async () => {
    const { fetchMock } = await start();
    const token = await mint({ client_id: "mcp_claude" });
    const c = await connect(token);
    const result = await c.callTool({ name: "resolve_birth_place", arguments: { place: "Warsaw", local_datetime: "1990-05-17T14:30" } });
    expect(JSON.parse(resultText(result))).toEqual(PLACE_JSON);
    expect((result as { structuredContent?: unknown }).structuredContent).toEqual(PLACE_JSON);
    const req = requestOf(fetchMock);
    expect(req.url).toBe("https://api.test/api/v1/astrology/resolve-place");
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.body).toEqual({ place: "Warsaw", local_datetime: "1990-05-17T14:30" });
  });

  it("passes an sk_stellara_ API key through as Authorization: Bearer for the backend to validate", async () => {
    const { fetchMock } = await start();
    const c = await connect(API_KEY);
    expect((await c.listTools()).tools).toHaveLength(4);
    await c.callTool({ name: "resolve_birth_place", arguments: { place: "Warsaw" } });
    expect(requestOf(fetchMock).headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(requestOf(fetchMock).headers["x-api-key"]).toBeUndefined();
  });

  it("does not accept an API key that lacks the sk_stellara_ prefix as an opaque bearer", async () => {
    await start();
    const r = await postMcp({ authorization: "Bearer totally-not-a-key" });
    expect(r.status).toBe(401);
  });

  it("explains a backend 401 as a sign-in problem and a 429 QUOTA_EXCEEDED as the daily quota", async () => {
    const { fetchMock } = await start({ fetchImpl: fetchStub(401, { detail: "TOKEN_REVOKED" }) });
    const c = await connect(await mint());
    const denied = await c.callTool({ name: "resolve_birth_place", arguments: { place: "Warsaw" } });
    expect(denied.isError).toBe(true);
    expect(resultText(denied)).toMatch(/sign in again|reconnect/i);
    expect(resultText(denied)).not.toContain("STELLARA_API_KEY");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client?.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await start({
      fetchImpl: (() => {
        const f = fetchStub(429, { detail: "QUOTA_EXCEEDED" });
        f.mockImplementation(async () => new Response(JSON.stringify({ detail: "QUOTA_EXCEEDED" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "3600" } }));
        return f;
      })(),
    });
    const c2 = await connect(await mint());
    const quota = await c2.callTool({ name: "resolve_birth_place", arguments: { place: "Warsaw" } });
    expect(quota.isError).toBe(true);
    expect(resultText(quota)).toContain("00:00 UTC");
    expect(resultText(quota)).toMatch(/Stellara Pro/);
  });

  it("is stateless: every POST is a fresh server, no Mcp-Session-Id is issued", async () => {
    await start();
    const r = await postMcp({ authorization: `Bearer ${await mint()}` });
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    const c = await connect(await mint());
    await c.listTools();
    await c.listTools();
  });
});
