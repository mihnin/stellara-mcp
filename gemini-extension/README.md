# Stellara — Gemini CLI extension

Packages the [`stellara-mcp`](https://www.npmjs.com/package/stellara-mcp) server as a
[Gemini CLI extension](https://geminicli.com/docs/extensions/): install once, get four
deterministic Swiss Ephemeris tools (`resolve_birth_place`, `calculate_natal_chart`,
`get_transits_and_aspects`, `calculate_synastry`) plus a `GEMINI.md` that teaches the model
the intake order (date → time + certainty → place → residence → name) and the
"compute, never guess" rules.

## Install (users)

```bash
gemini extensions install https://github.com/mihnin/stellara-gemini-extension
# → asks for "Stellara API key" (stored in the keychain, passed as STELLARA_API_KEY)
gemini            # restart the CLI, then:
/extensions list  # "stellara" should be listed
```

Get a key at https://stellara.natlex.it/#api — Free (5 requests/day, enough to try every
tool) or Stellara API Pro (5000/day, $9/month, cancel anytime). Requires Node.js ≥ 18
(`npx`).

Update later with `gemini extensions update stellara`; change the key with
`gemini extensions config stellara`.

## Publish (maintainers)

The gallery at https://geminicli.com/extensions/browse/ indexes public GitHub repos
automatically — no submission form. Requirements (from
[Release extensions](https://geminicli.com/docs/extensions/releasing)):

1. `gemini-extension.json` must be at the **root** of the repository, so this folder
   lives in its own small public repo (the `mihnin/astrolog` monorepo would make every
   install clone the whole app). Source of truth stays here; copy on release.
2. Add the GitHub topic **`gemini-cli-extension`** to the repository "About" section.
3. Keep `version` in `gemini-extension.json` in sync with the `stellara-mcp` npm version
   (the CLI shows the manifest version; `npx stellara-mcp@latest` always runs the newest
   published package).

One-time setup from this folder:

```bash
gh repo create mihnin/stellara-gemini-extension --public --description "Stellara Swiss Ephemeris astrology tools for Gemini CLI (MCP)" --clone
cp gemini-extension.json GEMINI.md README.md stellara-gemini-extension/
cd stellara-gemini-extension && git add . && git commit -m "stellara 0.2.2" && git push
gh repo edit mihnin/stellara-gemini-extension --add-topic gemini-cli-extension --add-topic mcp --add-topic astrology
# local test before pushing:
gemini extensions link .
```

The crawler runs daily; the listing appears once validation passes.
