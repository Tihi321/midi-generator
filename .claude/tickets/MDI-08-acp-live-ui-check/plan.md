# MDI-08: ACP live UI check and review fixes

Branch `MDI-08_acp-live-ui-check` (from master). Goal: Chiptune Studio passes fully on the ACP proxy (`http://127.0.0.1:7461/v1`), checked through the real Electron app, not just src/llm with tsx.

## Part A: fixes
1. `src/llm/seedMigrate.ts`: insert the migrated seed entry before `mock`, copying the seed's text (comments) verbatim, CRLF-safe (port of Pixel Studio `seedMigration.ts` insertion). Validate with providersSchema before writing. Update tests in `tests/llm/customProviders.test.ts` (or new seedMigrate test).
2. `LlmService.removeProvider` (src/main/llm.ts): if the saved `selectedModel` is a ref of the removed provider, reset it to null (and the renderer `chat.ts` already takes the overview from the reply; ensure `selectedModel` in the overview is reset). Test in tests/main.
3. providers.md writes: serialize read-modify-write in `customProviders.ts` with a per-file in-process promise mutex around saveCustomEntry / removeCustomEntry / setEntryEnabled (and migration). Test concurrent saves keep all entries.
4. Anything found in Part B.

## Part B: live check
- Wait for proxy GET /v1/models (only prefixed ids), poll 30 s up to 30 min. Do not start/stop the proxy.
- Back up ~/ChiptuneStudio/config to config.bak-mdi08, restore and diff at the end.
- Playwright `_electron` spec `tests/e2e/acp-live.spec.ts`, gated by `ACP_LIVE=1`: (a) Settings > Models shows acp + models, no unprefixed duplicates; (b) add custom provider `acp-e2e` via the form, Test, detect models, remove, chat selector still valid; (c) agent chat on `acp/codex/gpt-5.6-luna` and `acp/antigravity/gemini-3.8-flash`, assert a track was created, no error. Max ~6 agent runs; root-cause and unit-test any failure.

## Verification
vitest (check genesis timing test on master), typecheck, lint, build. ROADMAP.md entry MDI-08. Commit, no push.
