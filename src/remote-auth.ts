/**
 * Bearer-token verification for the remote (Streamable HTTP) mode.
 *
 * Two credentials are accepted on `POST /mcp`:
 *
 *   1. an OAuth 2.1 access token minted by the Stellara backend
 *      (`routers/oauth`): HS256 on the shared `JWT_SECRET`, `iss` = the
 *      authorization server, `aud` = this server's resource URL
 *      (`https://mcp.stellara.natlex.it/mcp`), `typ=mcp`, `scope` ⊇ `mcp`;
 *   2. an `sk_stellara_…` API key — passed through untouched; the backend
 *      validates it (hash lookup + daily quota) on the first tool call.
 *
 * Everything else is an `InvalidTokenError`, which the SDK middleware turns
 * into `401` + `WWW-Authenticate: Bearer … resource_metadata="…"` — the
 * challenge Claude uses to discover the authorization server.
 */
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { jwtVerify, type JWTPayload } from "jose";

export const API_KEY_PREFIX = "sk_stellara_";
export const MCP_SCOPE = "mcp";
const MCP_TOKEN_TYP = "mcp";
/** Nominal lifetime of an API-key "session" — the backend is the authority. */
const API_KEY_AUTH_TTL_SECONDS = 3600;

export interface TokenVerifierOptions {
  jwtSecret: string;
  issuer: string;
  /** RFC 8707 resource — the JWT `aud` this server accepts. */
  audience: string;
}

export type CredentialKind = "oauth" | "api_key";

function scopesOf(payload: JWTPayload): string[] {
  const raw = payload.scope;
  return typeof raw === "string" ? raw.split(/\s+/).filter(Boolean) : [];
}

export function createTokenVerifier(options: TokenVerifierOptions): OAuthTokenVerifier {
  const key = new TextEncoder().encode(options.jwtSecret);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token.startsWith(API_KEY_PREFIX)) {
        return {
          token,
          clientId: "api-key",
          scopes: [MCP_SCOPE],
          expiresAt: Math.floor(Date.now() / 1000) + API_KEY_AUTH_TTL_SECONDS,
          resource: new URL(options.audience),
          extra: { kind: "api_key" satisfies CredentialKind },
        };
      }
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, key, {
          algorithms: ["HS256"],
          issuer: options.issuer,
          audience: options.audience,
          requiredClaims: ["sub", "exp", "iat"],
        }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new InvalidTokenError(`Invalid access token: ${reason}`);
      }
      if (payload.typ !== MCP_TOKEN_TYP) {
        throw new InvalidTokenError("Invalid access token: not an MCP access token");
      }
      return {
        token,
        clientId: typeof payload.client_id === "string" ? payload.client_id : "unknown",
        scopes: scopesOf(payload),
        expiresAt: payload.exp,
        resource: new URL(options.audience),
        extra: { kind: "oauth" satisfies CredentialKind, sub: payload.sub },
      };
    },
  };
}
