import { describe, expect, it } from "vitest";

import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, KEY_HELP, readConfig } from "../src/config.js";

describe("readConfig", () => {
  it("defaults: no key, production base URL, 15 s timeout", () => {
    const c = readConfig({});
    expect(c.apiKey).toBeUndefined();
    expect(c.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(c.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
  });

  it("the default base URL points at the Stellara astrology API on its own subdomain", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.stellara.natlex.it/api/v1/astrology");
  });

  it("reads and trims STELLARA_API_KEY; blank counts as missing", () => {
    expect(readConfig({ STELLARA_API_KEY: "  sk_live_1  " }).apiKey).toBe("sk_live_1");
    expect(readConfig({ STELLARA_API_KEY: "   " }).apiKey).toBeUndefined();
    expect(readConfig({ STELLARA_API_KEY: "" }).apiKey).toBeUndefined();
  });

  it("reads STELLARA_API_BASE_URL and strips trailing slashes", () => {
    expect(readConfig({ STELLARA_API_BASE_URL: "http://localhost:8000/api/v1/astrology/" }).baseUrl).toBe(
      "http://localhost:8000/api/v1/astrology",
    );
    expect(readConfig({ STELLARA_API_BASE_URL: "  " }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("reads STELLARA_TIMEOUT_MS when it is a positive integer, else default", () => {
    expect(readConfig({ STELLARA_TIMEOUT_MS: "3000" }).timeoutMs).toBe(3000);
    expect(readConfig({ STELLARA_TIMEOUT_MS: "0" }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(readConfig({ STELLARA_TIMEOUT_MS: "soon" }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("KEY_HELP tells the user the variable name and where to get a key", () => {
    expect(KEY_HELP).toContain("STELLARA_API_KEY");
    expect(KEY_HELP).toContain("natlex.it");
  });
});
