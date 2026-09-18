#!/usr/bin/env node
/**
 * stellara-mcp — stdio entry point.
 *
 * stdout is the MCP protocol channel, so every human-facing line goes to
 * stderr. Configuration comes from STELLARA_API_KEY / STELLARA_API_BASE_URL
 * (see config.ts); a missing key does NOT prevent startup — the tools
 * explain how to fix it when called, which is friendlier for desktop
 * agents than a crash at launch.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readConfig } from "./config.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = readConfig();
  const server = createServer({ config });
  await server.connect(new StdioServerTransport());
  const keyState = config.apiKey ? "key configured" : "STELLARA_API_KEY missing — tools will explain how to set it";
  process.stderr.write(`stellara-mcp v${VERSION} ready on stdio (${config.baseUrl}; ${keyState})\n`);
}

main().catch((error) => {
  process.stderr.write(`stellara-mcp failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
