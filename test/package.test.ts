/**
 * What the npm tarball may contain. `files` is an allow-list of FILES, not folders:
 * a bare `docs` entry shipped the internal ops runbook (docs/PUBLISHING.md) inside
 * every tarball up to 0.2.2. The internal documents named here must never be
 * published — neither to npm nor to the public mirror (the sync script has its own
 * NEVER_MIRROR guard for the latter).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { files: string[]; repository: { url: string } };

const INTERNAL = ["docs/PUBLISHING.md", "docs/MCP_PLAYBOOK.ru.md"];

describe("package.json publish allow-list", () => {
  it("lists the two user-facing docs explicitly and never the docs folder as a whole", () => {
    expect(pkg.files).toContain("docs/USAGE.ru.md");
    expect(pkg.files).toContain("docs/GPT_ACTION.ru.md");
    expect(pkg.files).not.toContain("docs");
    expect(pkg.files).not.toContain("docs/");
    for (const internal of INTERNAL) {
      expect(pkg.files, `${internal} is internal`).not.toContain(internal);
    }
  });

  it("ships the runtime and the licence, nothing from src/test", () => {
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE", "CHANGELOG.md", "server.json"]));
    expect(pkg.files).not.toContain("src");
    expect(pkg.files).not.toContain("test");
  });

  it("points at the public source mirror, not the private monorepo", () => {
    expect(pkg.repository.url).toBe("git+https://github.com/mihnin/stellara-mcp.git");
  });
});
