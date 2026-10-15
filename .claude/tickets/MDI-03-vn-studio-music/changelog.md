# Changelog

## 2026-10-15: MDI-03, Chiptune Studio as a music generator for VN Studio (part of VNO-02)

Chiptune Studio can now run with no window (`yarn mcp`) and compose and render a calm, seamlessly looping track in two tool calls. Committed on `MDI-03_vn-studio-music` (02c867b); not pushed. Remaining work: visual-novels-orchestrator `.claude/tickets/VNO-02-chiptune-and-pixel-studio/next-steps.md`.

**Repo:** midi-generator. **Branch:** `MDI-03_vn-studio-music`, from `origin/master` @ 425bd0b.

### Headless mode
- **`src/main/{cli,headless,index}.ts`:** `--mcp-only [--port N]` runs the MCP server in the main process on a headless `SongSession` with Node services. No hidden window (the song model, registry and synth are pure TypeScript). No single-instance lock. Window mode keeps the lock; a second launch with `--open` hands the song to the open window. A taken MCP port shows as a status error and never crashes the window.
- **`src/main/ffmpeg.ts`:** ogg (libvorbis q6) and mp3 (libmp3lame q2) through ffmpeg from `FFMPEG_PATH` or PATH; falls back to WAV with a warning.
- **`package.json`:** `yarn mcp`.

### Tools
- **`src/tools/composer.ts`, `defs/studio.ts`:** `compose_track` (seeded procedural composer on the moods, progressions, scales, drum styles and presets), `render_audio`, `save_song`, `list_songs`, `open_song`, `delete_song`. Each ends with one JSON text item.
- **`src/tools/audioExport.ts`, `songStore.ts`, `inProcessAudio.ts`, `session.ts`, `services.ts`:** shared render-to-file (file ends at the loop end), several songs per session, `encodeAudio` and `studio` services.
- **Round trip:** `--open <file> [--export-to <file>] [--export-format]`; every save also exports the audio and writes `<exportTo>.json` with the loop points. Renderer: `state/actions.ts`, `main.tsx`, `toolBridgeClient.ts`; IPC in `shared/ipc.ts`.

### Music content
- Moods `ambient`, `lullaby`, `peaceful`, `mysterious-calm` (+ aliases), nine calm progressions, drum style `soft-pulse`.
- Soft presets: SNES `pad.soft-strings`, `strings.swell`, `pad.dream`, `bell.soft`, `flute.soft`, `bass.soft`; GB `pad.soft-square`, `lead.soft-square`, `bell.soft`, `bass.wave-soft`; NES `lead.soft`, `pad.soft-long`, `bell.soft`.

### Docs and tests
- `docs/llm-guide.md` (+ `yarn gen:guide`), `README.md`.
- New: `tests/tools/studio.test.ts`, `tests/main/headless.test.ts`. Updated bank-size and mood-list assertions in four existing tests.
