/**
 * stellara-mcp — remote entry point (Streamable HTTP on Cloud Run).
 *
 * PR 4 of docs/MCP_PHASE2_PLAN.ru.md. Same tools and prompts as the stdio
 * package, reachable at `https://mcp.stellara.natlex.it/mcp` so that
 * Claude.ai / Claude Desktop ("Add custom connector"), Claude Code, Cursor,
 * ChatGPT connectors, Grok and any remote-MCP client can use Stellara
 * without installing anything.
 *
 * Auth model (MCP authorization spec 2025-11-25):
 *   - this service is the *resource server*; the Stellara backend is the
 *     *authorization server* (`OAUTH_ISSUER`, routers/oauth);
 *   - `GET /.well-known/oauth-protected-resource[/mcp]` tells clients where
 *     to sign in; an unauthenticated `POST /mcp` answers 401 with
 *     `WWW-Authenticate: Bearer … resource_metadata="…"`;
 *   - a valid token (OAuth `typ=mcp` JWT or an `sk_stellara_` key, see
 *     remote-auth.ts) is forwarded to the API as `Authorization: Bearer` —
 *     the backend enforces the per-account / per-key daily quota.
 *
 * Stateless by design: every POST gets a fresh McpServer + transport, no
 * sessions, no SSE streams (`GET /mcp` → 405), so any Cloud Run instance
 * can serve any request. Unlike stdio, stdout is NOT a protocol channel
 * here, so logs go to stdout.
 */
import { pathToFileURL } from "node:url";

import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { readRemoteConfig, type RemoteConfig, type StellaraConfig } from "./config.js";
import { createTokenVerifier, MCP_SCOPE } from "./remote-auth.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

export const DOCS_URL = "https://github.com/mihnin/stellara-mcp#readme";
export const RESOURCE_NAME = "Stellara MCP";
const METADATA_CACHE = "public, max-age=3600";
const BODY_LIMIT = "1mb";
const AS_METADATA_FETCH_TIMEOUT_MS = 5000;

export interface RemoteAppOptions {
  config: RemoteConfig;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Authorization-server metadata to mirror; defaults to the known shape of routers/oauth. */
  authorizationServerMetadata?: OAuthMetadata;
}

/**
 * The backend's RFC 8414 document, reproduced statically so the mirror on
 * this host works even before the issuer has been reached (main() refreshes
 * it from `<issuer>/.well-known/oauth-authorization-server` at startup).
 * Keep in sync with backend/app/routers/oauth/metadata.py.
 */
export function buildAuthorizationServerMetadata(issuer: string): OAuthMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
    client_id_metadata_document_supported: true,
    service_documentation: DOCS_URL,
  } as OAuthMetadata;
}

export function buildProtectedResourceMetadata(config: RemoteConfig): OAuthProtectedResourceMetadata {
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: RESOURCE_NAME,
    resource_documentation: DOCS_URL,
  };
}

function cors(_req: Request, res: Response, next: NextFunction): void {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
  res.set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version");
  res.set("Access-Control-Max-Age", "86400");
  next();
}

export function createRemoteApp(options: RemoteAppOptions): Express {
  const { config } = options;
  const asMetadata = options.authorizationServerMetadata ?? buildAuthorizationServerMetadata(config.issuer);
  const prm = buildProtectedResourceMetadata(config);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(config.resourceUrl));
  const verifier = createTokenVerifier({ jwtSecret: config.jwtSecret, issuer: config.issuer, audience: config.resourceUrl });

  const app = express();
  app.disable("x-powered-by");
  app.locals.authorizationServerMetadata = asMetadata;
  app.use(cors);

  // Cloud Run's front end answers `/healthz` itself (Google 404 page, the
  // request never reaches the container — verified 2026-09-18), so the
  // probe lives at /health; /healthz stays for local runs only.
  const health = (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store").json({ status: "ok", service: "stellara-mcp", version: VERSION });
  };
  app.get("/health", health);
  app.get("/healthz", health);

  // RFC 9728 — path-specific URL first (what Claude probes), root as a fallback.
  const servePrm = (_req: Request, res: Response) => {
    res.set("Cache-Control", METADATA_CACHE).json(prm);
  };
  app.get(new URL(resourceMetadataUrl).pathname, servePrm);
  app.get("/.well-known/oauth-protected-resource", servePrm);
  // Glama connector claim — Glama re-checks this file periodically, so it is served
  // from config (env GLAMA_CLAIM_TOKEN) rather than deployed once as a static asset.
  if (config.glamaClaimToken) {
    const claim = { $schema: "https://glama.ai/mcp/schemas/connector.json", claim: config.glamaClaimToken };
    app.get("/.well-known/glama.json", (_req, res) => {
      res.set("Cache-Control", METADATA_CACHE).json(claim);
    });
  }
  // RFC 8414 mirror for clients that look up the AS on the resource host.
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.set("Cache-Control", METADATA_CACHE).json(app.locals.authorizationServerMetadata);
  });

  const mcpPath = new URL(config.resourceUrl).pathname;
  app.options(mcpPath, (_req, res) => {
    res.status(204).end();
  });
  app.post(
    mcpPath,
    express.json({ limit: BODY_LIMIT }),
    requireBearerAuth({ verifier, requiredScopes: [MCP_SCOPE], resourceMetadataUrl }),
    async (req, res, next) => {
      try {
        await handleMcpPost(req, res, config, options.fetchImpl);
      } catch (error) {
        next(error);
      }
    },
  );
  app.all(mcpPath, (_req, res) => {
    res.set("Allow", "POST, OPTIONS").status(405).json({ error: "method_not_allowed", message: "Use POST for MCP requests (stateless Streamable HTTP, no SSE stream)." });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    if (status >= 500) {
      console.error(`stellara-mcp remote: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    if (!res.headersSent) {
      res.status(status).json({ error: status >= 500 ? "server_error" : "bad_request" });
    }
  });
  return app;
}

async function handleMcpPost(req: Request, res: Response, config: RemoteConfig, fetchImpl?: typeof fetch): Promise<void> {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }
  const serverConfig: StellaraConfig = {
    apiKey: undefined,
    bearerToken: auth.token,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  };
  const server = createServer({ config: serverConfig, fetchImpl });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/** Best-effort: replace the static mirror with the issuer's live document. */
export async function refreshAuthorizationServerMetadata(app: Express, issuer: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AS_METADATA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${issuer}/.well-known/oauth-authorization-server`, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) return false;
    const doc = (await response.json()) as Partial<OAuthMetadata>;
    if (doc.issuer !== issuer || typeof doc.token_endpoint !== "string") return false;
    Object.assign(app.locals.authorizationServerMetadata as OAuthMetadata, doc);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const config = readRemoteConfig();
  const app = createRemoteApp({ config });
  app.listen(config.port, () => {
    console.log(`stellara-mcp v${VERSION} remote ready on :${config.port} — resource ${config.resourceUrl}, issuer ${config.issuer}, api ${config.baseUrl}`);
  });
  const refreshed = await refreshAuthorizationServerMetadata(app, config.issuer);
  console.log(`stellara-mcp remote: authorization-server metadata ${refreshed ? "refreshed from" : "static (could not fetch)"} ${config.issuer}`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  main().catch((error) => {
    console.error(`stellara-mcp remote failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
