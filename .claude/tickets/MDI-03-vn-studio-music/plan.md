# MDI-03: Chiptune Studio as a music generator for VN Studio

Branch: `MDI-03_vn-studio-music` (from `origin/master` @ 425bd0b). This is Section A of the cross-repo ticket VNO-02 in `visual-novels-orchestrator` (`.claude/tickets/VNO-02-chiptune-and-pixel-studio/plan.md`). The tool contract (names, inputs, result JSON) is in that ticket's `contracts.md`; this plan only covers how this repo implements it.

## Context

VN Studio needs calm, loopable game music from Chiptune Studio without a window being open. Today the MCP server only runs inside the app window because tool calls are bridged to the renderer, and there is no composer that makes a whole track in one call.

## Decisions

- **Headless = Node main process, no hidden window.** The song model (`src/core`), the tool registry (`src/tools`) and the synth (`src/core/synth`, `renderSong`) are pure TypeScript with no DOM, so the main process can host a `SongSession` plus `createToolHost(registry, ...)` directly. The renderer's render Worker stays for the window; the in-process renderer is only used where there is no window. A hidden window would have needed the whole renderer, an IPC round trip and a GPU process for nothing.
- **ffmpeg is a service, not a tool dependency.** `ToolServices.encodeAudio` takes WAV bytes and a target path; Node services run ffmpeg (`FFMPEG_PATH` or PATH) and fall back to WAV with a warning. In window mode the renderer calls it over IPC.
- **Several songs per session.** The live `SongSession.song` stays one stable object. Other songs are kept as project text in `session.held`, so `list_songs`, `open_song`, `delete_song` and `render_audio {song}` work in both modes.
- **Composer is pure and seeded** (`src/tools/composer.ts`): a mulberry32 PRNG, the existing moods, progressions, scales, drum styles and presets. Same seed and arguments give the same song.

## Checklist

- [x] 1. Moods `ambient`, `lullaby`, `peaceful`, `mysterious-calm`, progressions and a soft drum style for them
- [x] 2. Soft presets: SNES pads/strings, GB soft square (long release), soft NES
- [x] 3. `composer.ts` and `compose_track`
- [x] 4. `render_audio` (ogg/mp3 via ffmpeg, wav fallback, file ends at loop end), `save_song`, `list_songs`, `open_song`, `delete_song`
- [x] 5. Headless `--mcp-only [--port N]`, `yarn mcp`, single-instance rules, port-bind failure does not crash
- [x] 6. Window round trip: `--open <path> [--export-to <path>] [--export-format ogg|wav]`, auto-export on save, `second-instance` forwarding
- [x] 7. `docs/llm-guide.md` (+ `yarn gen:guide`) and README
- [x] 8. Tests: composer determinism, render length and loop points, headless MCP `tools/list` and `tools/call`
- [x] 9. Verification: `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build`, live `yarn mcp` smoke test
- [x] 10. `changelog.md`

## Verification evidence

- `yarn typecheck`, `yarn lint`: exit 0. `yarn test`: 65 files, 829 tests pass. `yarn build`: ok.
- Live: `yarn mcp` on 7458, SDK client: `tools/list` (54 tools), `compose_track {mood:ambient, chip:snes, seed:1}`, `render_audio` to an absolute ogg (ffprobe: vorbis, 44100 Hz, stereo, 56.470590 s = loopEndSample 2490353 / 44100).
- Window mode with a headless server on 7458: window opens, MCP status "Port 7458 is already in use", no crash. `--open ... --export-to` then `save_song` exported the ogg; a second launch handed a new `--open/--export-to` to the running window (needed a parser fix: Chromium reorders switches in second-instance argv).
- Not run: UI Ctrl+S click (same `exportOnSave` code path, not driven by hand); `yarn test:electron`.

## Deviations

- Added the "loop sidecar" `<exportTo>.json` on auto-export (orchestrator contract addition).
- compose_track has no intro bars (allowed range 0-2 in the contract; 0 is used).
