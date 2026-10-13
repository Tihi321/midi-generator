# MDI-02: Models page + OpenRouter free models + DeepSeek update (port of pixel-art-generator PAR-04)

Ticket folder: `.claude/tickets/MDI-02-models-page-openrouter-free-models-deepseek/`. Branch: `MDI-02_models_page` (created from `origin/master` @ f1635f2).

## Context

pixel-art-generator's last two commits:
- **PAR-03 (9d681dc)** "diff features": LM Studio discovery reworked (installed models only, drops embedding/draft models), context-size setting, Strata server context, chat history, document tabs.
- **PAR-04 (1d4564b, merged 3f2cf19)**: a **Settings → Models** tab where you tick which models the chat dropdown shows (`config/models.md`), OpenRouter `discover: free`, `discover_skip`, catalog "Detect models", add-by-id, DeepSeek `json_schema: false` + reasoning round-trip for thinking + tools, OpenRouter attribution headers, dropdown grouped by provider with a "Models..." button. Every model is opt-in.

Findings in midi-generator:
- The LLM part of PAR-03 is **already here**: ignoring CRLF, `src/llm/*`, `src/main/llm.ts`, `agentIpc.ts`, `appSettings.ts`, `src/shared/agent.ts`, `agentApi.ts`, `state/chat.ts`, `SettingsDialog.tsx`, `ChatPanel.tsx`, the seed configs and the LLM tests are identical to pixel @ 9d681dc except for product names (`Pixel Studio`→`Chiptune Studio`, `PixelStudio`→`ChiptuneStudio`, `PIXEL_STUDIO_HOME`→`CHIPTUNE_STUDIO_HOME`, `pixelStudio`→`chiptuneStudio`, roles `artist/palette`→`composer/theory`, tool names `draw_grid/get_document`→`write_pattern/get_song` in tests).
- PAR-03's non-model features (document tabs, `workspace.ts`) are pixel-editor specific and out of scope.
- So the work is a **near-mechanical port of the PAR-04 diff** (`git -C ../pixel-art-generator diff 9d681dc 72c846f -- src seed tests`). `git apply --check` fails only on hunks whose context contains the product names, plus `state/ui.ts` and `tests/e2e/smoke.spec.ts` (structurally different in midi).
- `~/ChiptuneStudio/config` does not exist, so no live-config patching is needed; `ensureConfigDir` copies the seed (incl. new `models.md`) on first run.

## Approach

1. Create the branch and ticket folder.
2. Produce the PAR-04 patch from pixel, rewrite names with sed (the list above, plus OpenRouter headers: `https://github.com/Tihi321/midi-generator`, `X-Title: Chiptune Studio`), then `git apply --ignore-whitespace` (fall back to `--3way` / `--reject` and fix rejects by hand). Keep midi's CRLF/LF style per file.
3. Hand-merge the two files the patch can't apply:
   - `src/renderer/state/ui.ts`: add `export type SettingsTab = 'providers' | 'models' | 'mcp'`, `settingsTab: SettingsTab` in `UiData` (default `'providers'`), `openSettings(tab)` on `UiState`; `openDialog` resets `settingsTab` to `'providers'` when opening `'settings'` (pixel's exact semantics).
   - `tests/e2e/smoke.spec.ts` (settings test ~l.58-65): after the providers checks, click `settings-tab-models` and expect `settings-models` visible; rename the test title to mention Models.
4. Review the result for leftover pixel wording (`grep -ri "pixel\|artwork\|draw" src/llm src/main/llm.ts src/renderer/components/ModelsTab.tsx seed/config`), e.g. in `ModelsTab.tsx` hints, `MODELS_MD_BODY` in `modelChoices.ts`, `seed/config/models.md`, the providers.md docs body.

### Files touched (from the PAR-04 diff)
- New: `src/llm/modelChoices.ts`, `src/renderer/components/ModelsTab.tsx`, `src/renderer/components/Badges.tsx` (moved out of `ChatPanel.tsx`), `src/renderer/state/modelOptions.ts`, `seed/config/models.md`, `tests/llm/modelChoices.test.ts`, `tests/renderer/modelOptions.test.ts`.
- Changed: `src/llm/{config,openaiCompat,registry,gemini,index}.ts`, `src/main/{llm,agentIpc}.ts`, `src/shared/agent.ts`, `src/renderer/lib/agentApi.ts`, `src/renderer/state/{chat,ui}.ts`, `src/renderer/components/{SettingsDialog,ChatPanel}.tsx`, `src/renderer/styles.css` (append the 69-line Models block; only uses `--bg`/`--border`, both exist in midi), `seed/config/providers.md` (DeepSeek `json_schema: false`; OpenRouter `rpm: 20`, `discover: free`, `discover_skip: [content-safety]`, `json_schema: false`; docs body), tests `tests/llm/{clients,registry}.test.ts`, `tests/main/agentLlm.test.ts`, `tests/e2e/smoke.spec.ts`.

### Behaviour delivered (same as pixel)
- Settings → Models tab: provider list with tick counts / unavailable reason; filter, Detect models, "free only", "ticked only", Tick all / Untick all; rows with context, price, tools/vision badges, source; paid rows without a price disabled; Add by id (id, $in, $out, context); missing-key hint.
- Chat dropdown: "Default (...)" + ticked models + the current selection, `<optgroup>` per provider, "Models..." button opening Settings on the Models tab.
- `models.md` (`shown`, `picked`; legacy `hidden` read and dropped) persists choices; router/roles fallback unchanged.

## Not in scope
PAR-03 document tabs/workspace; scriptorium fallback-order/limits UI; rpd/daily quotas.

## Verification
1. `yarn typecheck && yarn lint && yarn test` (all pass, incl. the new modelChoices/modelOptions tests).
2. `yarn test:electron` (smoke spec opens the Models tab).
3. Manual (`yarn dev`): Settings → Models → OpenRouter → Detect models with a key; tick two → they appear under an "openrouter" group in the chat dropdown; untick → gone; restart → ticks persist in `~/ChiptuneStudio/config/models.md`. LM Studio: tick an installed model, chat with it. DeepSeek v4-pro composing with tool calls → no HTTP 400.
4. Write `changelog.md` in the ticket folder; commit `MDI-02: ...` on the branch (not pushed) once checks pass.

Implementation runs through the global `implement` skill with this plan file.

## Implementation status

- [x] 1. Branch + ticket folder (already on MDI-02_models_page)
- [x] 2. PAR-04 patch ported with renames (sed renames; `git apply --ignore-whitespace` excluding ui.ts and smoke.spec.ts; CRLF preserved; patch at .claude/temp/midi.patch). No role/tool renames were needed in the patch.
- [x] 3. ui.ts + smoke.spec hand-merged
- [x] 4. Leftover pixel wording reviewed. The orchestrator reworded the vision badge title in `Badges.tsx` ("sees the piano-roll preview from render_preview"); the 'I should draw' test string is left as is.
- [x] Verification: typecheck 0, lint 0, test 63 files / 798 tests pass, test:electron 24 passed
- [x] changelog.md written. Committed as 92579e5 (not pushed).
