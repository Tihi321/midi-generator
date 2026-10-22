# MDI-05: Roadmap features

Branch: `MDI-05_roadmap-features`, cut from `master` @ 13b4e92. One branch, one commit per task below (in this order). Do not push.

Source: `ROADMAP.md` (2026-10-22). Each task removes its line from `ROADMAP.md` in the same commit; the last task also updates "Where it stands".

Commit messages: `MDI-05: <summary>` (repo convention), ending with the attribution line.

## Context

- Headless MCP: `src/main/cli.ts` (argv parsing, `DEFAULT_HEADLESS_PORT` 7458), `src/main/index.ts:93` (`cli.port ?? DEFAULT_HEADLESS_PORT`), `src/main/headless.ts` (already reads `CHIPTUNE_STUDIO_MCP_TOKEN` and `CHIPTUNE_STUDIO_HOME`).
- Composer: `src/tools/composer.ts` (`composeSong`, pure, seeded mulberry32), tool def `compose_track` in `src/tools/defs/studio.ts`.
- Rendering: `src/tools/audioExport.ts` (`renderSongToFile`; a looping song renders intro + loop body and the file ends at the loop end; `loopStartSec` = intro length).
- Melody text format: `src/core/codecs/melodyText.ts` (`parseMelodyText(text, song, channelRef)`), the same format as `write_melody`.
- `sfx` role exists in `src/core/instruments/roles.ts`; presets per chip in `src/core/instruments/presets/*.ts`.
- Docs: `docs/llm-guide.md` -> `yarn gen:guide` regenerates `src/tools/guideText.ts` (short section max 1500 chars). README "Headless MCP" section and tool table.
- Consumer: VN Studio (`C:\projects\Personal\visual-novels-orchestrator`) calls `compose_track` + `render_audio`; it has `sfx_` / `amb_` sounds and `sound.sfxEngine` (only `custom:<comfy workflow>` today). Wiring VN Studio to a new SFX tool is out of scope here (other repo); only note it in the changelog as the next step.

## Rules for every task

- Backward compatible: `compose_track` with none of the new arguments must produce exactly the same song as today for the same seed (existing determinism tests must stay green unchanged). New randomness must not consume calls on the main RNG when the new options are absent; use a separate RNG derived from the seed (e.g. `createRng(seed ^ 0x9e3779b9 ^ k)`) for new features.
- Every tool result still ends with one JSON text item (`okJson`).
- Match the surrounding code style (short comment headers, no extra abstractions).
- After each task: `yarn typecheck`, `yarn lint`, `yarn test` pass before committing.

## Tasks

### 1. `CHIPTUNE_STUDIO_MCP_PORT` for the headless port

- `src/main/cli.ts`: headless port resolution: `--port` wins, else `CHIPTUNE_STUDIO_MCP_PORT`, else 7458. Add a pure helper (e.g. `headlessPort(cli, env = process.env): { port, warning? }`) so it is testable; an invalid env value gives a warning and the default (same wording style as the `--port` warning).
- `src/main/index.ts`: use it in `--mcp-only` mode. The window keeps its Settings > MCP port (the env var is headless only; say so in docs).
- Docs: README headless section (`CHIPTUNE_STUDIO_MCP_PORT=7500 yarn mcp`), header comment of `cli.ts`.
- Tests: new `tests/main/cli.test.ts` (or extend an existing one if found): flag wins over env, env used, invalid env -> warning + default, no env -> 7458.
- Commit: `MDI-05: CHIPTUNE_STUDIO_MCP_PORT sets the headless MCP port`.

### 2. `compose_track` intro

- New option `intro` (bars 0..4, default 0). The intro is played once before the loop: pads and bass only on the first chord (tonic) of the progression, quieter, no lead and no drums (a calm fade-in feel); the last intro bar may lead into the first chord (e.g. dominant / last numeral of the progression).
- Song layout: intro bars come first; the loop starts after them: `song.loop = { order: intro / patternBars }`. Choose `patternBars` from [4, 2, 1] dividing both the body bars and the intro bars. `bars` / `seconds` still mean the loop body length; total bars capped at 128 + 4 is fine, but keep the body cap at 128.
- Result: `loop: { startBar: intro, endBar: intro + bars }`, new `introBars`; `durationSec` is the whole song. Tool text says the intro plays once and render_audio's `loopStartSec` is the intro end.
- Tool def: add `intro` (`z.number().int().min(0).max(4).optional()`), update the description.
- Tests (`tests/tools/studio.test.ts`): intro 2 -> loop starts at the right order, render loopStartSec ≈ 2 bars, intro has no lead notes; intro 0 equals today's output.
- Commit: `MDI-05: compose_track intro bars before the loop`.

### 3. `compose_track` motif / leitmotif

- New option `motif`: a short melody in the `write_melody` text format (note names, `:N` lengths in rows, `r` rests, `~` ties; instrument/volume/effect tokens and chords are rejected or ignored with a clear message), at most 4 bars (64 rows). Optional `motifKey` (default "C"): the key the motif is written in.
- Placement: the motif is transposed from `motifKey` to the track key, folded into the lead's range, and each note snapped to the track scale (so a major motif fits a minor track). It is the lead line of phrase A (bars 0.. of every even 4-bar phrase, from bar 0 after any intro); odd phrases (B) and the remaining bars stay generated. When the motif is shorter than the phrase, the generated melody continues after it from its last note. Strong-beat notes of the motif are kept as written (a leitmotif must be recognisable); only out-of-scale notes move.
- Development: in later repeats of phrase A, light variation of the motif with the separate RNG: the last note or two may change to fit the cadence chord, and every second repeat may be sequenced (moved by a scale step matching the chord root). Keep it recognisable.
- Parsing: reuse `parseMelodyText` against the composed song's lead channel (or a small dedicated parser if that does not fit; prefer reuse). Errors name the column like `write_melody`.
- Result: `motif: { bars, transposeSemis, placedAtBars: number[] } | null`. Tool text mentions where the motif plays.
- Tool def: `motif`, `motifKey` with descriptions and an example (`"E5:4 G5:2 A5:2 B5:8"`).
- Tests: motif notes appear transposed at bar 0 of the lead channel; same seed + same motif deterministic; motif longer than 4 bars errors; no motif equals today's output.
- Commit: `MDI-05: compose_track motif (leitmotif) input`.

### 4. `compose_track` variation mode

- New option `variation` (int 0..99, default 0). Same seed + other args, variation 0 = the original track. Variation k > 0 keeps the harmony and identity of the track (key, scale, bpm, chip, progression, chord sequence, instruments, motif) and re-rolls the arrangement with an RNG seeded from (seed, k): lead rhythms and steps (motif phrases stay, with their development re-rolled), bass pattern (may move one step busier/calmer within the mood, e.g. hold <-> rock for calm moods), pad voicing / entry offset, drum fill placement. So a VN can have "the same theme" for several scenes.
- Implementation: decide the harmony first with the main RNG exactly as today, then for variation > 0 switch the arrangement draws to the variation RNG. Variation 0 must not change any existing draw.
- Result: `variation` echoed in JSON and text.
- Tool def: `variation` with a description ("a different arrangement of the same track: same key, chords and motif").
- Tests: variation 1 has the same chords/key/bpm as variation 0 but different lead notes; deterministic; variation 0 equals today's output.
- Commit: `MDI-05: compose_track variation mode`.

### 5. Sound effects, stingers and ambience: `compose_sfx`

- New pure module `src/tools/sfx.ts` (same style as `composer.ts`: no DOM, no Electron, seeded) building short songs with the existing model, presets and effects (pitch slides `1xx`/`2xx`, arpeggio `0xy`, volume, noise channel):
  - `kind: "sfx"`, names: `coin`, `jump`, `hit`, `explosion`, `laser`, `powerup`, `blip` (menu select), `confirm`, `cancel`, `door`, `footstep`, `chime`, `magic`, `heal`, `alert`, `text` (dialogue blip), `thunder`. One-shot (loop null), under ~2 s.
  - `kind: "stinger"`, names: `success`, `fail`, `reveal`, `danger`, `sad`, `mystery`, `discovery`, `romance`, `level-up`. 1-2 bars, one-shot, uses `key` (default C) and the chip's lead/pad/bass presets; ends on a held chord with release room.
  - `kind: "ambience"`, names: `wind`, `rain`, `waves`, `cave`, `night`, `fire`, `drone`, `machine`. Looping over the whole song (loop end = song end), `seconds` (default 16, 4..120) rounded to whole bars, noise swells via volume per row, optional low drone in `key`. Seamless loop: the end leads back into the start (same level at both ends).
- Each one-shot gets enough trailing empty rows for the release/decay tail; check how `renderSongToFile` ends a non-looping song and make sure the tail is not cut (add rows rather than changing the renderer if possible).
- Options: `kind`, `name`, `chip` (default nes for sfx, snes for stingers/ambience; any chip works), `key`, `seconds` (ambience), `pitch` (semitones, -12..12, sfx/stinger), `seed` (small seeded variation of the same effect), `name` of the song (`songName`).
- Tool `compose_sfx` in `src/tools/defs/studio.ts` (registered with the rest): creates the song and makes it current via `activateSong` (like `compose_track`); optional `path` (+ `format`) renders it in the same call with `renderSongToFile` and returns the file info too. Unknown name -> error listing the names for that kind. Returns `{songId, kind, name, chip, durationSec, loop, seed, ...render info when path}`.
- Docs: `docs/llm-guide.md` section on sounds (+ `yarn gen:guide`), README tool table. Keep the short guide under 1500 chars.
- Tests: `tests/tools/sfx.test.ts`: every name of every kind on every chip builds a valid song (`validateSong` no errors); one-shots have loop null and duration < 3 s (stingers < 6 s); ambience loops, ends at loop end, length matches `seconds`; deterministic per seed; render through the tool host gives a file (reuse the helpers of `studio.test.ts`). Update tool-count assertions if any.
- Commit: `MDI-05: compose_sfx for sound effects, stingers and ambience`.

### 6. Wrap up

- `docs/llm-guide.md` / README mention intro, motif, variation (if not already done in tasks 2-4) and regenerate the guide.
- `ROADMAP.md`: all items done; "Where it stands" updated with the new commit; leave the file with what is still open (VN Studio wiring of `compose_sfx` as `sound.sfxEngine`, which lives in visual-novels-orchestrator).
- `yarn build` passes. Live smoke test: `yarn mcp` (and once with `CHIPTUNE_STUDIO_MCP_PORT=7501`), an MCP SDK client: `tools/list` contains `compose_sfx`; `compose_track {mood:"ambient", seed:1, intro:2, motif:"E5:4 G5:4 A5:8", variation:1}` + `render_audio` to an absolute ogg in `.claude/temp/`; `compose_sfx {kind:"sfx", name:"coin", path:<abs .ogg>}`; `compose_sfx {kind:"ambience", name:"rain", seconds:8, path:...}`. ffprobe durations match the reported ones.
- `.claude/tickets/MDI-05-roadmap-features/changelog.md` (same style as MDI-03's) with verification evidence.
- Commit: `MDI-05: Docs, roadmap and ticket changelog`.

## Verification

Per task: `yarn typecheck`, `yarn lint`, `yarn test`. At the end: `yarn build` and the live smoke test above. Temp files go to `.claude/temp/`.

## Progress

(A task's commit hash is recorded in the next task's commit, since a commit cannot contain its own hash.)

- Task 1: done, commit e956104. `headlessPort(cli, env)` in `src/main/cli.ts`, used by `--mcp-only` in `src/main/index.ts`; new `tests/main/cli.test.ts` (4 tests); README + ROADMAP "Running" item removed. typecheck, lint pass; yarn test 833 passed (66 files). Deviations: none.
- Task 2: done. `intro` (0..4) in `composeSong` / `compose_track`: rows are written after an `off` offset (`put` is relative to the loop body), intro bars hold the tonic bass and pad(s) (volume 8 / 5, last bar of a 2+ bar intro on the progression's last chord), no lead, arp or drums; `patternBars` divides both body and intro; result has `introBars`; loop `{startBar: intro, endBar: intro + bars}`. Added `tests/tools/composerPin.test.ts` (sha256 prefixes of 7 option sets, taken from the unmodified composer, to pin "no new options = same song"), intro tests in `tests/tools/studio.test.ts`, `channelRows` helper in `tests/tools/helpers.ts`. Docs: README, llm-guide, generated guide; ROADMAP trimmed. Verification: typecheck, lint pass; yarn test 845 passed (67 files). Deviations: none.
