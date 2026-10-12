# Changelog: Chiptune Studio

## 2026-10-12 · (no ticket id) · Chiptune Studio v0.0.1: chiptune composer with built-in LLM chat and MCP, 8-bit + 16-bit chips

**Outcome:** a new Electron desktop app in `midi-generator` that mirrors Pixel Studio's architecture. LLMs compose game music through about 50 tools, from the built-in chat or any MCP client. The music plays on five emulated chips: NES and Game Boy (8-bit), and Genesis FM+PSG, SNES and PC Engine (16-bit). Songs export to WAV with loop points, per-channel stems and MIDI.

### Repository `C:\projects\Personal\midi-generator`
- **Branch:** `chiptune-studio-llm-mcp`, from `origin/master` 78fd2f1.
- **Files:** 290 new files, all untracked so far; `README.md` is unchanged.

**Config and scripts**
- `package.json` (Yarn 4, Electron 44, React 19, zod 4, `@modelcontextprotocol/sdk`, bin `chiptune-studio-mcp`)
- The two tsconfigs, the electron-vite, vite.mcp, vitest, playwright and eslint configs, and `electron-builder.yml`
- `scripts/gen-guide.mjs`, `seed/config/{providers,roles}.md` (role `composer`)

**`src/core/` (pure TS)**
- `types.ts` is the domain contract: Song, Cell, Pattern, chip configs and the Instrument union.
- `model.ts`, `notes.ts`, `commands.ts`: History with transactions, and cell, order, instrument, sample, channel and song commands.
- `chips/*`: profiles and strict/relaxed validation for the five chips, with error messages that say how to fix the problem.
- `instruments/*`:
  - macros and roles;
  - preset banks: NES 27, GB 27, Genesis 34, SNES 27, PCE 27, plus Genesis DAC and NES DPCM sample presets.
- `theory/*`: 16 scales, 45 progressions, 21 drum styles, 16 mood recipes, and key/chord/clash analysis.
- `codecs/*`:
  - text notations `trackerText`, `melodyText`, `drumText`;
  - `project.ts` (`.ctune`);
  - `wav.ts` (smpl loop chunk and INFO), `png.ts`;
  - MIDI: `midi.ts`, `midiFile.ts`, `midiImport.ts`, `gmMap.ts`, `slots.ts`, `songBuild.ts`.
- `convert.ts`: `convertChip` between any two chips.
- `synth/*`:
  - Engine: Blip band-limited steps, LFSRs, a tick sequencer with every tracker effect, the shared timeline, a mixer with stems, and `SongPlayer` (block-size independent).
  - `renderSong` renders a seamless loop.
  - Chip voices:
    - NES `apu2a03`, GB `dmg`, PCE `huc6280`.
    - Genesis: `ym2612` (4-op FM) and `sn76489`.
    - SNES `spc700`: Gaussian interpolation, ADSR/GAIN, and an echo/FIR bus.
    - `sample`: NES DPCM and Genesis F6 DAC.
  - `samplegen/*`: 21 seeded recipes and a closed-loop BRR encoder.

**`src/tools/`**
- `SongSession`: undo shared by the UI, the agent and MCP, with "Undo agent turn".
- `ToolRegistry` with zod schemas.
- About 50 tools in `defs/*`:
  - song, channels and orders;
  - notes (`write_pattern`, `write_melody`, `write_drums`, …) and reading (`read_pattern`, `render_preview` piano-roll PNG, `analyze_song`);
  - instruments, samples and theory;
  - export (`export_wav`, `export_midi`, `import_midi`, `convert_chip`), playback and history;
  - library (`list_assets`, `get_asset`, `save_as_asset`, `place_asset`, `set_style_reference`, `get_style_context`).
- Also: `render.ts`, `editing.ts`, `assetOps.ts`, and in-memory services for tests.

**`src/llm/`:** copied from Pixel Studio and renamed. Providers are OpenAI-compatible (LM Studio, Strata, DeepSeek, OpenRouter, Ollama, OpenAI), Anthropic and Gemini, plus a mock. The layer includes tool calling, the agent loop with a JSON-action fallback, and keyring keys under the service name `chiptune-studio`.

**`src/main/`:**
- tool bridge to the renderer;
- MCP Streamable HTTP server on `127.0.0.1:7458/mcp` with an optional bearer token:
  - resources `chiptune-studio://{guide,song,presets,assets}`;
  - prompts `compose_track`, `remix_to_chip`, `match_style`;
- agent runner: system prompt = guide + song + style context, auto piano-roll preview for vision models;
- chat history, app settings, file services;
- asset store with chokidar watching.

**`src/mcp-stdio/`:** stdio↔HTTP shim for clients that only support stdio.

**`src/renderer/`**
- **Editors:**
  - tracker (FamiTracker keys, selection, clipboard, transpose) and piano roll (draw, move, resize);
  - order list and transport;
  - per-kind instrument editors: macros, GB wave/envelope, PCE waves, FM operators with algorithm diagram, SNES ADSR/sample;
  - SNES echo controls.
- **Panels:** Library (motifs, instruments, songs, style references) and Chat.
- **Dialogs:** New, Open, Save, Export (WAV, stems, MIDI), Import MIDI, Convert chip, Settings (providers, MCP).
- **Audio:** AudioWorklet live playback with hot-swap of edits, and a render Worker for exports.

**Other**
- `docs/llm-guide.md` is the single source of the system prompt, the MCP instructions and the guide resource; the short part is 1500 characters or fewer.
- **Tests:**
  - 61 Vitest files with 782 tests across core, synth (goldens per chip), tools, LLM, main, MCP and renderer;
  - 24 Playwright Electron tests: smoke, editor, MIDI, and an MCP integration test against the running app.

### Deviations from the plan (and why)
- Two files were written by the orchestrator so parallel agents could work against a fixed contract:
  - the shared `src/core/types.ts` before Phase 2;
  - `SongSession` and the `AudioService` interface before Phase 3.
- `midiToHz`/`hzToMidi` are exported only from `core/notes`, because the synth copy clashed with it in `core/index.ts`.
- **Tool details:**
  - `read_pattern` also supports `format: "drums"`.
  - `write_drums` defaults to C6 on PC Engine and V8 on SNES, because those chips have no noise channel.
  - `save_as_asset` is read-only and creates no undo step, as in Pixel Studio.
  - `convert_chip` drops melodic channels it can't fit and reports them, rather than merging them; macros and hand-made patches are not carried over.
- **Accepted limits:**
  - The NES nonlinear mix is mono; stems only sum exactly to the master with the linear mix model.
  - No chip is cycle-accurate. The known gaps are listed per phase in `plan.md`.
- **UI:**
  - Export progress is coarse (`renderSong` has no progress callback).
  - Mute and solo are not saved in the song.
  - The tracker has no row insert/delete shifting.
- `tests/e2e/editor.spec.ts`: string `page.waitForFunction` was replaced with a `page.evaluate` polling helper, because the app's CSP blocks eval.

### Verification
- `yarn gen:guide`: pass.
- `yarn typecheck` (node and web): pass.
- `yarn lint`: pass.
- `yarn test`: pass, 61 files / 782 tests.
- `yarn test:electron` (build + Playwright, isolated `CHIPTUNE_STUDIO_HOME` and MCP port): pass, 24 tests.
- Demo through the real tool registry (`npx tsx .claude/temp/demo.ts`):
  - It composes the guide's NES example, converts it to every chip, and exports each one.
  - Output in `.claude/temp/demo/`: `hero-{nes,gb,genesis,snes,pce}.wav` and `hero-nes.mid`. Each is 7.3 s, non-silent and has an smpl loop, with peaks of 0.49–0.92.

**Not run:**
- listening by a human;
- real LLM endpoints (LM Studio, Strata, cloud) and a live Claude Code MCP session;
- `yarn dev`;
- `yarn dist` packaging.

### Follow-ups and known limitations
- Listen-test every chip and tune the presets and mix levels by ear.
- Test MIDI import with real-world files; all current tests use synthetic files.
- Untested: the stdio shim with Claude Desktop, and `yarn dist`.
- **Possible improvements:**
  - tracker row insert/delete;
  - a progress callback for `renderSong`;
  - PCE DDA;
  - SNES noise and pitch modulation;
  - the YM2612 channel-3 special mode.

### Commit status
Uncommitted. All changes are untracked files on branch `chiptune-studio-llm-mcp`.
