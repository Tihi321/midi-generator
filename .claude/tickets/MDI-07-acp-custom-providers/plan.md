# MDI-07: ACP proxy and custom OpenAI-compatible providers

Branch `MDI-07_acp-custom-providers` (from master 17d3aeb). Ports SCP-44 / BTT-21 to Chiptune Studio. The LLM layer `src/llm/*` is shared in shape with Pixel Studio (PAR-14, another worker): keep the same names (`custom`, `name` fields, `seed-state.json`, `acp` seed, reserved ids).

## Design
1. **Seed `acp`** in `seed/config/providers.md`: kind openai-compat, `name: ACP proxy`, enabled false, local true, base_url `http://127.0.0.1:7461/v1`, concurrency 2, json_schema false, discover true, models []. Body gets a docs note (PROXY_IGNORE_SAMPLING=1, text only, ids like `codex/gpt-5.6-luna`, tools default off for local providers, Antigravity terms risk) and the new `custom` / `name` fields.
2. **Schema** (`config.ts`): provider entry gets `name?: string`, `custom: boolean = false`.
3. **Migration** `src/llm/seedMigrate.ts`: `migrateSeedProviders(configDir, seedDir)`; `config/seed-state.json` `{version:1, providers:[offered ids]}`. For each seed provider in a small list (`acp`) that is not offered yet: if providers.md lacks the id, append the seed entry (yaml `parseDocument` round trip, comments and hand edits kept); record it as offered either way. A user who deletes `acp` later does not get it back. Called from `createLlm` after `ensureConfigDir`. A migration failure never blocks start (logged by returning a warning).
4. **Custom providers** `src/llm/customProviders.ts` (pure, no Electron): `RESERVED_PROVIDER_IDS` (acp, anthropic, gemini, openai, openrouter, deepseek, lmstudio, strata, ollama, mock, claude, local, paid, search), `customKeyName`, `customProviderSlug`, `checkBaseUrl`, `saveCustomEntry(file, input)` (add or edit, only `custom: true` entries; validates url, concurrency, unique id, reserved ids; model list written; `api_key_env` `CUSTOM_<ID>_API_KEY` when a key is given), `removeCustomEntry`, `setProviderEnabled`. Input: name, baseUrl, apiKeyEnv/withKey, concurrency, jsonSchema, discover, models (ids), free (local), enabled.
5. **Service** (`src/main/llm.ts`): `saveCustomProvider`, `removeCustomProvider` (also removes its stored key, its `shown`/`picked` refs in models.md), `testCustomProvider` (GET /models), `setProviderEnabled`; each reloads the registry (no restart) and re-discovers. IPC `llm:saveProvider|removeProvider|testProvider|setProviderEnabled`; `LlmProviderInfo` gets `name`, `custom`, `jsonSchema`, `concurrency`.
6. **UI**: Settings > Models tab: "Add provider" button and form (name, base URL, key env/key, concurrency, json_schema, discover, free/local, model ids one per line), Edit/Remove on custom providers, Enable/Disable for seed providers like acp, Test button. Provider names shown.
7. **Discovery for acp**: the registry already lists `GET /models`; add a test that ids with slashes (`codex/gpt-5.6-luna`) become refs `acp/codex/gpt-5.6-luna` and are resolvable.
8. Docs: README provider section, ROADMAP row MDI-07, ticket changelog.

## Tests
- `tests/llm/customProviders.test.ts`: add/edit/remove round trip keeps comments, reserved ids, duplicate ids, bad URL, builtin entries not editable, registry loads custom entry, setProviderEnabled.
- `tests/llm/seedMigrate.test.ts`: adds acp once, idempotent, keeps user edits, not re-added after deletion, fresh install records.
- registry test for acp discovery with fake fetch; llm service test for save/remove/test via fake fetch.
- `yarn test`, `yarn typecheck`, `yarn build`.

## Out of scope
Pixel Studio repo, live user config, real ACP proxy calls (live check not run).
