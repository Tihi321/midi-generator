# Changelog

## 2026-10-27: MDI-07, ACP proxy and custom OpenAI-compatible providers

Branch `MDI-07_acp-custom-providers` (from master 17d3aeb). Uncommitted until the commit that carries this file.

- `src/llm/config.ts`: provider entries take `name` and `custom`.
- `src/llm/customProviders.ts` (new): add / edit / remove `custom: true` entries and switch any provider on or off, by a `yaml` document round trip (comments and hand edits stay); reserved ids (acp, seed providers, role names), URL and parallel checks.
- `src/llm/seedMigrate.ts` (new), `setup.ts`: `seed-state.json` lists seed providers already offered; `acp` is added once to an existing providers.md, never overwrites an entry, not re-added after a delete. A failure never blocks start.
- `src/llm/registry.ts`: `ProviderInfo.name` / `custom`.
- `src/main/llm.ts`, `agentIpc.ts`, `src/shared/agent.ts`, `renderer/lib/agentApi.ts`, `state/chat.ts`: `saveProvider`, `removeProvider` (also deletes the stored key and its models.md refs), `testProvider` (GET /models), `setProviderEnabled`; the registry reloads and re-discovers, no restart.
- `renderer/components/ProviderForm.tsx` (new), `ModelsTab.tsx`, `SettingsDialog.tsx`: Add provider form, Edit / Remove / Enable-Disable, provider names.
- `seed/config/providers.md`: `acp` entry and docs (PROXY_IGNORE_SAMPLING, text only, tools default off, terms risk, custom providers).
- `tests/llm/customProviders.test.ts` (new, 9 tests).

Deviations: the free/paid distinction is the form's "free / local" box (`local`), no per-model price fields in the form. Seed-state records only migrated seed providers (`acp`), not every seed id as in Book Translator.

Verification: `yarn test` 874 pass, 1 fails (tests/core/synth/genesis.test.ts performance timing under parallel load; passes alone, unrelated); `yarn typecheck` exit 0; `yarn lint` exit 0; `yarn build` exit 0.
Not run: the form in the real app (no Playwright/Electron run), a live call to the ACP proxy on 7461, the live user config (not touched).
