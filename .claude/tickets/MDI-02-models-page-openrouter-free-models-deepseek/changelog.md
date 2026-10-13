# Changelog

## 2026-10-13: MDI-02, Models page, OpenRouter free models and DeepSeek update (port of pixel-art-generator PAR-04)

The chat model dropdown now offers only the models you tick in Settings > Models. Free OpenRouter models are listed automatically, LM Studio models can be ticked, and DeepSeek works with thinking plus tools. The changes are uncommitted.

**Repo:** midi-generator. **Branch:** `MDI-02_models_page`, cut from `origin/master` @ f1635f2.

**How it was ported:** the PAR-04 diff in pixel-art-generator (`git diff 9d681dc 72c846f -- src seed tests`) was renamed to Chiptune Studio, the midi-generator GitHub URL and midi's test tool names, then applied with `git apply`. midi's LLM layer was already identical to pixel's at PAR-03, so only `state/ui.ts` and `tests/e2e/smoke.spec.ts` needed hand merging. CRLF line endings are preserved.

### Files changed

#### Provider config and client
- **`src/llm/config.ts`**
  - `discover` accepts `true | false | 'free'`.
  - New `discover_skip`.
  - New `modelsSchema` for `config/models.md`, with `shown` and `picked`. A legacy `hidden` key is still read.
- **`src/llm/openaiCompat.ts`**
  - `listModelInfo()` reads each model's context, max output, price per 1M tokens, text-only flag, and tool and vision support.
  - New `extraHeaders` option, used for OpenRouter attribution (`HTTP-Referer` midi-generator, `X-Title: Chiptune Studio`).
  - The reasoning from DeepSeek (`reasoning_content`) or OpenRouter (`reasoning`) is kept on the first tool call and sent back on that assistant turn.
- **`src/llm/gemini.ts`:** only a string `thoughtSignature` is forwarded from `providerMeta`.

#### Registry, model choices and IPC
- **`src/llm/registry.ts`**
  - Loads `models.md`.
  - `ModelInfo.source` and `shown` are new: every model is opt-in, and picked models are always shown.
  - Free models are discovered on a `discover: 'free'` provider.
  - `discover_skip` filters model ids.
  - New `catalog()` and `listedModels()`.
  - `guessFamily` falls back to the maker prefix.
- **`src/llm/modelChoices.ts`** (new): reads and edits `models.md`, with `showModels` and `addModel`. A paid model with no price is refused.
- **`src/llm/index.ts`:** exports the new pieces.
- **`src/shared/agent.ts`, `src/main/llm.ts`, `src/main/agentIpc.ts`, `src/renderer/lib/agentApi.ts`:** new `LlmModelInfo` and `LlmProviderInfo` fields, new catalog types, and the IPC calls `llm:catalog`, `llm:showModels` and `llm:addModel`.

#### UI
- **`src/renderer/components/ModelsTab.tsx`** (new): Settings > Models.
  - Provider list with tick counts.
  - Filter box and a Detect models button.
  - "free only" and "ticked only" filters, plus Tick all and Untick all.
  - Each row shows context, price, tools and vision badges, and source.
  - Add-by-id form, and a hint when a key is missing.
- **`src/renderer/components/Badges.tsx`** (new): moved out of ChatPanel and given a `compact` mode. The vision tooltip now refers to the piano-roll `render_preview` image instead of the old "drawing step" wording.
- **`src/renderer/components/SettingsDialog.tsx`:** a third tab, Models, which opens on `ui.settingsTab`.
- **`src/renderer/components/ChatPanel.tsx`:** the dropdown shows ticked models plus the current selection, grouped with `<optgroup>` by provider. A "Models..." button opens Settings on the Models tab.
- **`src/renderer/state/ui.ts`:** `SettingsTab`, `settingsTab` and `openSettings(tab)`. `openDialog('settings')` resets the tab to Providers.
- **`src/renderer/state/chat.ts`:** `catalogs`, plus `detect`, `showModels` and `addModel`.
- **`src/renderer/state/modelOptions.ts`** (new): groups the dropdown's models.
- **`src/renderer/styles.css`:** Models tab and model-row styles.

#### Config
- **`seed/config/providers.md`**
  - DeepSeek: `json_schema: false`.
  - OpenRouter: `rpm: 20`, `discover: free`, `discover_skip: [content-safety]` and `json_schema: false`.
  - The docs body is extended.
- **`seed/config/models.md`** (new).
- No live config was touched: `~/ChiptuneStudio/config` does not exist yet, and the seed is copied on first run.

#### Tests
- Updated: `tests/llm/clients.test.ts`, `tests/llm/registry.test.ts`, `tests/main/agentLlm.test.ts` and `tests/e2e/smoke.spec.ts` (the Settings test opens the Models tab).
- New: `tests/llm/modelChoices.test.ts` and `tests/renderer/modelOptions.test.ts`.

### Deviations from the plan
- No role renames were needed: the PAR-04 diff contains no `artist` or `palette` references.
- The vision badge tooltip was reworded for music. That text was already in midi before the port.

### Verification
- The implementer ran these after the port:
  - `yarn typecheck`: OK.
  - `yarn lint`: OK.
  - `yarn test`: 63 files and 798 tests passed.
  - `yarn test:electron`: 24 passed.
- After the tooltip edit, the orchestrator re-ran `yarn typecheck` and `yarn lint`: both OK.

**Not run (need keys or a live LM Studio):**
- OpenRouter Detect and tick.
- Ticking an LM Studio model and chatting with it.
- DeepSeek v4-pro tool calls with thinking on.
- Ticks persisting across a restart.

### Follow-ups and known limitations
- PAR-03's document tabs and workspace were not ported (out of scope). Its LLM parts were already in midi.
- OpenRouter's daily free-tier quota is not handled.
- DeepSeek's `/models` lists no prices, so new DeepSeek models go in through Add by id.
- A model unticked in the dropdown can still be used through `roles.md` (Default) or as a fallback.

### Commit status
Uncommitted on `MDI-02_models_page`.
