/**
 * Shared test plumbing: an in-process MCP client ↔ server pair over
 * `InMemoryTransport`, plus fetch stubs. Every behavioural test drives the
 * server through the real MCP protocol, so what we assert is exactly what
 * Claude Desktop / Hermes / Cursor would observe.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi } from "vitest";

import { readConfig, type StellaraConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

export const TEST_ENV = {
  STELLARA_API_KEY: "sk_test_abc",
  STELLARA_API_BASE_URL: "https://api.example.test/v1/astrology",
};

export const EINSTEIN = {
  birth_datetime: "1879-03-14T10:30:00Z",
  latitude: 48.4011,
  longitude: 9.9876,
};

export const DIANA = {
  birth_datetime: "1961-07-01T18:45:00Z",
  latitude: 52.8333,
  longitude: 0.5,
};

export type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/** A fetch stub that always answers with `status` + JSON `body`. */
export function fetchStub(status: number, body: unknown): FetchMock {
  return vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

/** A fetch stub that never resolves but honours `signal` (for timeouts). */
export function hangingFetch(): FetchMock {
  return vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
  );
}

export interface Harness {
  client: Client;
  fetchMock: FetchMock;
  close: () => Promise<void>;
}

export async function connectServer(options: {
  env?: Record<string, string>;
  fetchImpl?: FetchMock;
  timeoutMs?: number;
} = {}): Promise<Harness> {
  const config: StellaraConfig = readConfig(options.env ?? TEST_ENV);
  if (options.timeoutMs !== undefined) config.timeoutMs = options.timeoutMs;
  const fetchMock = options.fetchImpl ?? fetchStub(200, { ok: true });

  const server = createServer({ config, fetchImpl: fetchMock });
  const client = new Client({ name: "stellara-mcp-tests", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    fetchMock,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Text of the first content block of a tool result. */
export function resultText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const first = r.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`expected a text content block, got ${JSON.stringify(r)}`);
  }
  return first.text;
}

/** Parsed request the fetch stub received on its n-th call. */
export function requestOf(fetchMock: FetchMock, call = 0): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
} {
  const [input, init] = fetchMock.mock.calls[call] ?? [];
  if (input === undefined) throw new Error(`fetch was not called ${call + 1} time(s)`);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return {
    url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    method: init?.method ?? "GET",
    headers,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
  };
}
