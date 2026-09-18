/**
 * Package version, read from package.json at runtime so `bin`, the
 * User-Agent header and the MCP `serverInfo` can never drift apart.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
