# midi-generator

Chiptune Studio: a chiptune and MIDI composer (NES, Game Boy, Genesis, SNES, PC Engine) with a built-in LLM agent and an MCP server. Electron 44, React 19, TypeScript, yarn.

```
yarn install
yarn dev          # the app with hot reload
yarn build        # build the app and the stdio MCP shim
yarn test         # vitest
yarn typecheck && yarn lint
```

The tool guide for LLM agents is `docs/llm-guide.md`. It is compiled into `src/tools/guideText.ts`: after editing it run `yarn gen:guide`.

## MCP server

In the app window the MCP server listens on `http://127.0.0.1:7458/mcp` (Settings > MCP has the port, an optional token and copy-paste connection snippets). The tools edit the song that is open in the window.

### Headless mode (no window)

```
yarn build
yarn mcp                         # = electron . --mcp-only      (packaged: "Chiptune Studio.exe" --mcp-only)
yarn mcp --port 7500
```

- It starts the same MCP Streamable HTTP server with no window and logs `MCP listening on http://127.0.0.1:<port>/mcp` to stdout. Default port 7458.
- Every tool runs in the Electron main process (plain Node) on a headless song: the song model, the tool registry and the synth are pure TypeScript, so audio renders offline in-process. There is no hidden window and no renderer. `play` / `stop` are not available; `render_audio` gives you a file instead.
- It does not take the single-instance lock, so it can run next to the app window. If the window is started while the headless server holds port 7458, the window still opens and Settings > MCP shows `Port 7458 is already in use`. Use `--port` for one of them.
- `CHIPTUNE_STUDIO_HOME` moves the data folder (default `~/ChiptuneStudio`). `CHIPTUNE_STUDIO_MCP_TOKEN` sets a bearer token for the headless server.
- Files and paths: an absolute path is used as is (parent folders are created); a relative file name goes to `~/ChiptuneStudio/exports` (audio) or `~/ChiptuneStudio/projects` (`.ctune`).

### Tools for other apps (VN Studio)

| Tool | What it does |
| --- | --- |
| `compose_track` | `{mood, chip?, bpm?, key?, scale?, bars?, seconds?, loop?, seed?, instruments?, name?}`: composes a whole track (progression, bass, pads, melody, optional drums) and makes it the current song. Deterministic per seed. Calm moods `ambient`, `lullaby`, `peaceful`, `mysterious-calm` use soft presets, 60-90 BPM and no or very quiet drums. |
| `render_audio` | `{path, song?, format?: ogg\|wav\|mp3, loops?, fadeOutSec?, sampleRate?}`: renders to one file. ogg and mp3 need ffmpeg (`FFMPEG_PATH`, else on PATH); without it a `.wav` is written next to the path and `warning` says so. A looping song ends exactly at the loop end; the result has `loopStartSec` / `loopEndSec` (and samples) for a seamless loop. |
| `save_song` / `open_song` | save or load the native `.ctune` file; `open_song` takes `exportTo` / `exportFormat` to export the audio on every save. |
| `list_songs` / `delete_song` | the songs held in this session; deleting never touches files. |

Each of these returns readable text first and one JSON object as the last text item (the fields are listed in `docs/llm-guide.md`).

### Open a song from the command line (window mode)

```
electron . --open path/to/song.ctune --export-to path/to/music.ogg [--export-format ogg|wav]
```

The song opens in the window. Every time it is saved (Ctrl+S or Save) the looping audio is also rendered to `--export-to`. Launching again while the app runs (a second instance) hands the song to the open window.
