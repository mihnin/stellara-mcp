/**
 * Unit tests for the typed HTTP client: URL joining, headers, timeout and
 * the error taxonomy the tools translate into agent-facing messages.
 */
import { describe, expect, it, vi } from "vitest";

import { StellaraApiError, StellaraClient } from "../src/client.js";
import { fetchStub, hangingFetch, requestOf } from "./helpers.js";

const BASE = "https://api.example.test/v1/astrology";

function client(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof StellaraClient>[0]> = {}) {
  return new StellaraClient({ apiKey: "sk_test", baseUrl: BASE, timeoutMs: 15_000, fetchImpl, ...overrides });
}

describe("StellaraClient request shape", () => {
  it("joins the endpoint onto the base URL and sends JSON with the key", async () => {
    const f = fetchStub(200, { ok: 1 });
    const data = await client(f).post("natal", { a: 1 });
    expect(data).toEqual({ ok: 1 });
    const req = requestOf(f);
    expect(req.url).toBe(`${BASE}/natal`);
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ a: 1 });
    expect(req.headers["x-api-key"]).toBe("sk_test");
    expect(req.headers["accept"]).toMatch(/application\/json/);
    expect(req.headers["content-type"]).toMatch(/application\/json/);
    expect(req.headers["user-agent"]).toMatch(/^stellara-mcp\/\d+\.\d+\.\d+$/);
  });

  it("normalizes a trailing slash on the base URL", async () => {
    const f = fetchStub(200, {});
    await client(f, { baseUrl: `${BASE}///` }).post("synastry", {});
    expect(requestOf(f).url).toBe(`${BASE}/synastry`);
  });

  it("passes an AbortSignal so the request can time out", async () => {
    const f = fetchStub(200, {});
    await client(f).post("transits", {});
    const [, init] = f.mock.calls[0];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("StellaraClient error taxonomy", () => {
  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [429, "rate_limited"],
    [400, "validation"],
    [422, "validation"],
    [500, "server"],
    [503, "server"],
  ] as const)("HTTP %s → kind %s", async (status, kind) => {
    const err = await client(fetchStub(status, { detail: "X" })).post("natal", {}).catch((e) => e);
    expect(err).toBeInstanceOf(StellaraApiError);
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.detail).toEqual({ detail: "X" });
  });

  it("429 + detail QUOTA_EXCEEDED → kind quota_exceeded with Retry-After parsed", async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ detail: "QUOTA_EXCEEDED" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "3600",
            "x-quota-limit": "50",
            "x-quota-remaining": "0",
          },
        }),
    );
    const err = await client(f).post("natal", {}).catch((e) => e);
    expect(err).toBeInstanceOf(StellaraApiError);
    expect(err.kind).toBe("quota_exceeded");
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(3600);
  });

  it("429 without the QUOTA_EXCEEDED token stays rate_limited (slowapi per-minute limit)", async () => {
    const plain = await client(fetchStub(429, { detail: "RATE_LIMITED" })).post("natal", {}).catch((e) => e);
    expect(plain.kind).toBe("rate_limited");
    expect(plain.retryAfterSeconds).toBeUndefined();
    const text = vi.fn<typeof fetch>(async () => new Response("Too Many Requests", { status: 429 }));
    const nonJson = await client(text).post("natal", {}).catch((e) => e);
    expect(nonJson.kind).toBe("rate_limited");
  });

  it("ignores a malformed Retry-After header", async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ detail: "QUOTA_EXCEEDED" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "tomorrow" },
        }),
    );
    const err = await client(f).post("natal", {}).catch((e) => e);
    expect(err.kind).toBe("quota_exceeded");
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("keeps a non-JSON error body as text detail", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response("Bad Gateway", { status: 502 }));
    const err = await client(f).post("natal", {}).catch((e) => e);
    expect(err.kind).toBe("server");
    expect(err.detail).toBe("Bad Gateway");
  });

  it("network failure → kind network", async () => {
    const f = fetchStub(200, {});
    f.mockRejectedValue(new TypeError("fetch failed"));
    const err = await client(f).post("natal", {}).catch((e) => e);
    expect(err).toBeInstanceOf(StellaraApiError);
    expect(err.kind).toBe("network");
  });

  it("timeout → kind timeout, after roughly timeoutMs", async () => {
    const started = Date.now();
    const err = await client(hangingFetch(), { timeoutMs: 25 }).post("natal", {}).catch((e) => e);
    expect(err.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("200 with a non-JSON body → kind server", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response("<html/>", { status: 200 }));
    const err = await client(f).post("natal", {}).catch((e) => e);
    expect(err.kind).toBe("server");
  });

  it("messages are human-readable and name the endpoint", async () => {
    const err = await client(fetchStub(500, {})).post("transits", {}).catch((e) => e);
    expect(String(err.message)).toMatch(/transits/);
    expect(String(err.message)).toMatch(/500/);
  });
});
