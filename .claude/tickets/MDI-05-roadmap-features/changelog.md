# Changelog

## 2026-10-22: MDI-05, the ROADMAP features

The four roadmap items are done: the headless port can come from an environment variable; `compose_track` gained an intro, a leitmotif input and a variation mode; and a new `compose_sfx` tool makes sound effects, stingers and ambience loops. Committed on `MDI-05_roadmap-features`, one commit per task (not pushed).

**Repo:** midi-generator. **Branch:** `MDI-05_roadmap-features`, from `origin/master` @ 13b4e92.

| Commit | Task |
| --- | --- |
| `e956104` | 1. `CHIPTUNE_STUDIO_MCP_PORT` sets the headless MCP port |
| `4d20f91` | 2. `compose_track` intro bars before the loop |
| `e88ce15` | 3. `compose_track` motif (leitmotif) input |
| `ff5e38c` | 4. `compose_track` variation mode |
| `8dc5775` | 5. `compose_sfx` for sound effects, stingers and ambience |
| `3e716bd` | 6. Docs and roadmap (this changelog is in the commit after it) |

### Headless port
- **`src/main/cli.ts`:** `headlessPort(cli, env)`. `--port` wins, then `CHIPTUNE_STUDIO_MCP_PORT`, then 7458. An invalid env value prints a warning and the default is used.
- **`src/main/index.ts`:** `--mcp-only` uses it. The app window keeps its Settings > MCP port, so the variable only affects headless mode.

### compose_track (`src/tools/composer.ts`, `src/tools/defs/studio.ts`)
- **`intro` (0..4 bars):**
  - The intro plays once before the loop. It has quiet bass and pad on the tonic. With 2 or more bars, the last bar is on the progression's last chord. There is no lead, arp or drums.
  - The loop starts after the intro, so `render_audio`'s `loopStartSec` is the end of the intro.
  - `bars` / `seconds` set the loop body length. The result has `introBars`, and `loop` is `{startBar: intro, endBar: intro + bars}`.
- **`motif`, with optional `motifKey` (default C):**
  - The motif uses the `write_melody` text format: notes, `r` and `~` only, at most 4 bars. It is parsed with `parseMelodyText`. Instrument, volume, chord and effect tokens are rejected with the column number.
  - It is moved from `motifKey` to the track's key (shortest shift) and into the lead's range. Notes outside the scale move to the nearest scale note.
  - It is the lead line at bar 0 and every 8 bars after that. Later repeats change a little, using an RNG of their own: the ending is pulled to the chord, and every second repeat is moved by a scale step or two.
  - The result has `motif: {bars, transposeSemis, placedAtBars}`.
- **`variation` (0..99):**
  - Key, scale, tempo, progression, chords, instruments and the motif statement stay the same.
  - With k > 0, an RNG seeded from (seed, k) re-rolls the arrangement: lead rhythm and steps, the bass pattern one step busier or calmer, pad voicing and entry, and how often drum fills come.
  - Variation 0 makes no extra draws, so it is the original track.
- **Backward compatible:** `tests/tools/composerPin.test.ts` pins song hashes for 7 option sets. The hashes were computed on the composer before these changes.

### compose_sfx (`src/tools/sfx.ts`, `src/tools/defs/studio.ts`, `src/tools/index.ts`)
- `src/tools/sfx.ts` is pure and seeded, built on the existing song model and presets.
- **Kinds and sounds:**

  | Kind | Sounds |
  | --- | --- |
  | `sfx` | `coin`, `jump`, `hit`, `explosion`, `laser`, `powerup`, `blip`, `confirm`, `cancel`, `door`, `footstep`, `chime`, `magic`, `heal`, `alert`, `text`, `thunder` |
  | `stinger` | `success`, `fail`, `reveal`, `danger`, `sad`, `mystery`, `discovery`, `romance`, `level-up` |
  | `ambience` | `wind`, `rain`, `waves`, `cave`, `night`, `fire`, `drone`, `machine` |

- **Inputs:** `kind`, `sound`, `chip` (default nes for sfx, snes for the other two), `key`, `seconds` (ambience, 4..120), `pitch` (-12..12), `seed`, `songName`, and optional `path` / `format` to render in the same call. An unknown `sound` is an error that lists the valid names for that kind.
- **Sfx:** played at 300 BPM, one 50 ms row per step. Pitch slides are rows of notes, not slide effects, so they work on every chip. There are no per-chip `sfx` presets, so tones use role presets and noise uses the chip's drum presets. One-shots use the renderer's existing 0.5 s tail; the last 50 ms was checked to be near silent on every chip.
- **Stingers:** 2 bars in `key`, ending on a held chord.
- **Ambience:** loops over the whole song. A slow level cycle makes both ends of the loop match, and there is an optional drone in `key`.

### Docs
- `README.md`: the headless port variable, the new `compose_track` options and a `compose_sfx` row.
- `docs/llm-guide.md`, with `src/tools/guideText.ts` regenerated. The short guide is at 1499/1500 characters, so `compose_sfx` is only in the full guide.
- `ROADMAP.md`: the four items are removed, and one open item is left (below).

### Tests
- New: `tests/main/cli.test.ts`, `tests/tools/composerPin.test.ts` and `tests/tools/sfx.test.ts`. `sfx.test.ts` checks that every sound on every chip is valid and audible, the loop shape, determinism, pitch and key, the tool result, and rendering to a file.
- Extended: `tests/tools/studio.test.ts` (intro, motif, variation) and `tests/tools/helpers.ts` (`channelRows`).

### Deviations
- The effect's input field is named `sound`, not `name`, so it does not clash with the song name (`songName`).
- Sfx pitch slides are rows of notes, not `1xx`/`2xx` effects, so they behave the same on every chip.
- There are no trailing rows for the release tail; the renderer's 0.5 s one-shot tail was enough.
- The changelog is in its own commit after task 6, because it was written after reviewing the work.

### Verification
- `yarn typecheck` and `yarn lint` exited 0 after every task.
- `yarn test` after each task:

  | After | Result |
  | --- | --- |
  | Start | 833 passed |
  | Task 1 | 833 passed |
  | Task 2 | 845 passed |
  | Task 3 | 852 passed |
  | Task 4 | 858 passed |
  | Task 5 | 866 passed |
  | Final | 865 passed, 1 failed |

- **The final failure** is `tests/core/synth/genesis.test.ts > performance > renders 3 minutes of a 10-channel Genesis song in under 3 s`, a wall-clock limit. It took 3.1 to 3.8 s while other processes kept the CPU at 78-86%. No file under `src/core` or `tests/core` differs from master, and all 866 tests passed right before the task 6 commit. Re-run it on a quiet machine to confirm.
- **`yarn build`:** passes. The only warning is the existing rollup chunk-size one.
- **Live smoke test:** `yarn mcp` with an MCP SDK Streamable HTTP client (scratch in `.claude/temp/`):
  - `tools/list` returned 55 tools, `compose_sfx` among them.
  - `compose_track {mood:"ambient", seed:1, intro:2, motif:"E5:4 G5:4 A5:8", variation:1}` then `render_audio` to an ogg:

    | Value | Reported | ffprobe |
    | --- | --- | --- |
    | Duration | 63.52941 s | 63.529410 s |
    | `loopStartSec` | 7.058821 (2 bars at 68 BPM) | not probed |
    | Motif placed at bars | 0, 8 | n/a |

  - `compose_sfx coin` with `path`: 1.15 s reported, 1.150000 s from ffprobe, no loop.
  - `compose_sfx ambience rain seconds:8` with `path`: 8 s reported, loop 0 to 8 s (sample 352800), 8.000000 s from ffprobe.
  - `CHIPTUNE_STUDIO_MCP_PORT=7501 yarn mcp` listened on 7501, and the client run worked there. `CHIPTUNE_STUDIO_MCP_PORT=abc` printed the warning and used 7458.
- **Not run:**
  - Listening tests: the sounds, motif development and variations were checked for structure only.
  - `yarn test:electron`.

### Follow-ups
- VN Studio (visual-novels-orchestrator) does not call `compose_sfx` yet. A `sound.sfxEngine: "chiptune"` value there could call it with `path` for `sfx_` and `amb_` sounds. This is the one open item in `ROADMAP.md`.
- Raise or relax the Genesis performance test's 3 s limit if it keeps failing on a loaded machine.

### Commit status
Committed on `MDI-05_roadmap-features`: the six task commits plus the changelog commit. Not pushed and no PR.
