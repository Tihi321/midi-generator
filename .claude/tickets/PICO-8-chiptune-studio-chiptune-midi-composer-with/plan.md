# Chiptune Studio: chiptune/MIDI composer with an LLM agent and MCP

## Context
`C:\projects\Personal\midi-generator` is empty: a README and one commit (78fd2f1) on `master`. The user wants the music counterpart of `C:\projects\Personal\pixel-art-generator` (Pixel Studio):
- a desktop app where a built-in LLM chat and outside MCP clients compose game music in different tones and moods ("heroic overworld", "spooky dungeon", "chill shop");
- authentic **8-bit** (NES, Game Boy) and **16-bit** (Genesis FM, SNES samples, PC Engine wavetable) synth sound.

Pixel Studio is the template. It has a pure-TS core with commands and undo, an LLM-friendly text codec, one zod `ToolRegistry` shared by the chat agent and MCP, a `ToolBridge` from main to the renderer, a provider layer written over raw `fetch`, the MCP server, the stdio shim and a guide generator. Its own plan is at `pixel-art-generator/.claude/tickets/PICO-8-pixel-studio-pixel-art-editor-with/plan.md`.

The infrastructure is **copied nearly verbatim**; the music domain is new.

**User decisions**
| Question | Choice |
|---|---|
| Chips | NES 2A03, Game Boy DMG, Genesis YM2612 + SN76489 PSG, SNES SPC700, PC Engine HuC6280 |
| Editor | Tracker pattern grid plus a piano-roll tab |
| Export | `.mid`, WAV with loop points (`smpl` chunk), WAV stems per channel, project JSON |
| Library | Saved instruments, motifs and songs, with style references (`get_style_context`) |

**Naming:** app "Chiptune Studio", package `chiptune-studio`, project files `.ctune`.

**Global CLAUDE.md conventions**
- When implementation starts, copy this plan to `.claude/tickets/chiptune-studio-llm-mcp/plan.md`.
- Implement through the `implement` skill.
- Put scratch files in `.claude/temp/`, which is gitignored.

## Stack (identical to Pixel Studio's `package.json`)
- **Runtime and build:** Electron ^44, electron-vite ^5, Vite ^7, electron-builder (NSIS x64).
- **Code:** TypeScript ~5.9 (strict, `noUncheckedIndexedAccess`), React 19, zustand 5, zod 4, yaml.
- **Libraries:** `@modelcontextprotocol/sdk` ^1.32, `@napi-rs/keyring`, chokidar, fflate (for the piano-roll PNG preview).
- **Packages and tests:** Yarn 4 Berry with `nodeLinker: node-modules`, Vitest ^5, Playwright, ESLint.
- **No audio dependencies.** The synth is pure TS and runs in an AudioWorklet for playback, a Worker for export, and Node for tests.
- **Configs and scripts:** the scripts `dev`, `build`, `build:mcp`, `test`, `test:electron`, `typecheck`, `lint`, `gen:guide` and `dist` are copied. The two tsconfigs (node and web) and `vite.mcp.config.ts` are copied too.

## Copy and rename from Pixel Studio (adapt names only)
**Files copied**
- `src/llm/**`: providers, agent loop, JSON-action fallback, keys, config, router.
- `src/main/`:
  - `toolBridge.ts`, `mcp.ts`, `mcpContent.ts`, `mcpSettings.ts`, `mcpApp.ts`
  - `agent.ts`, `agentIpc.ts`, `llm.ts`, `appSettings.ts`, `chatHistory.ts`
  - `services.ts`, `assets.ts`, `assetsApp.ts`, `index.ts`
- `src/mcp-stdio/**`, `src/preload/index.ts`, `src/shared/{tools,ipc,mcp,agent,assets}.ts`.
- `src/tools/registry.ts`, `session.ts` (EditorSession, `beginTurn`/`endTurn`), `services.ts`, `memoryServices.ts`, `util.ts`.
- `src/core/commands.ts`: the `History` and transaction machinery.
- Renderer: `components/ChatPanel.tsx`, `SettingsDialog.tsx`, `state/chat*.ts`, `lib/agentApi.ts`, `toolBridgeClient.ts`, `lib/tools.ts`.
- `scripts/gen-guide.mjs`, `seed/config/{providers,roles}.md` (rename the `artist` role to `composer`).
- Test helpers `tests/{tools,mcp,e2e}/helpers|launch.ts` and the LLM tests.

**Renames**
| Pixel Studio | Chiptune Studio |
|---|---|
| keyring service `pixel-studio` | `chiptune-studio` |
| `PIXEL_STUDIO_HOME`, `PIXEL_STUDIO_MCP_PORT`, `PIXEL_STUDIO_MCP_URL`, `PIXEL_STUDIO_MCP_TOKEN` | `CHIPTUNE_STUDIO_*` |
| data root `~/PixelStudio` | `~/ChiptuneStudio/{config,exports,projects,assets,chats,samples}` |
| MCP port 7457 | 7458 (both apps can run together) |
| resource scheme `pixel-studio://` | `chiptune-studio://` |
| `window.pixelStudio` | `window.chiptuneStudio` |
| bin `pixel-studio-mcp` | `chiptune-studio-mcp` |

**What changes in the copied main-process code**
- `AgentRunner`'s system prompt becomes GUIDE + `get_song` + `get_style_context`, the latter only when references exist.
- `withAutoPreview` runs `render_preview` (a piano-roll PNG) after write tools, for vision models only.
- `ToolServices` gains `audio { render(song, opts), play(from?), stop(), position() }`.
  - In the renderer it is implemented by the Worker and the AudioWorklet.
  - In tests it calls `renderSong` in-process.

## Architecture (new domain code)
```
src/core/
  model.ts commands.ts notes.ts
  chips/{types,nes,gb,genesis,snes,pce,index}.ts
  instruments/{types,macros,roles}.ts + presets/{nes,gb,genesis,snes,pce}.ts
  theory/{scales,chords,progressions,drums,moods,analyze}.ts
  synth/{blip,lfsr,tables,sequencer,timeline,mixer,player,render}.ts
  synth/chips/{apu2a03,dmg,sn76489,ym2612,spc700,huc6280,dpcm}.ts
  synth/samplegen/{generators,brr,gauss,bank}.ts
  codecs/{trackerText,melodyText,drumText,midi,wav,project,png,gmMap}.ts
src/tools/defs/{song,channels,order,notes,reading,instruments,theory,assets,export,playback,history,index}.ts
src/tools/render.ts                      piano-roll PNG
src/renderer/audio/{worklet,audioEngine,renderWorker}.ts
docs/llm-guide.md                        single source for the system prompt, MCP instructions and guide resource
```

### Song model (`src/core/model.ts`): tracker-native, like FamiTracker and Furnace
```ts
type ChipId = 'nes'|'gb'|'genesis'|'snes'|'pce'
type NoteValue = number /*MIDI*/ | 'off' | 'rel'
interface Cell { note?: NoteValue; inst?: number; vol?: number /*0..15*/; fx?: {code; param}[] }
interface Song {
  format: 1; id; name; chip: ChipId; chipConfig; authenticity: 'strict'|'relaxed'
  meta: { key; scale; moods: string[]; tags: string[]; notes? }
  timing: { bpm; speed /*ticks per row*/; rowsPerBeat; beatsPerBar; groove?: number[] }
  patternLength: number; channels: ChannelState[]           // channels are fixed by the chip profile
  orders: number[][]                                        // orders[row][channel] = pattern number
  patterns: Map<`${channelId}:${n}`, Pattern>               // sparse, like Pixel Studio cels
  instruments: Instrument[]; samples: SampleSlot[]; loop: {order}|null; references: RefLink[]
}
```
- The piano roll is a view of this model: a note lasts until the next note, a note-off or a release.
- Lookups accept an id, a name or an index. When a lookup fails, the error lists the valid values.
- **Commands:**
  - `createCellsCommand(diffs)` is the single write primitive. Write, transpose, copy and clear all build on it.
  - The others are `createSetOrdersCommand`, `createInstrumentCommand`, `createSongInfoCommand`, `createChannelCommand`, `createSampleCommand`, `createReplaceSongCommand` and `createCompositeCommand`.

### LLM text notations (the music equivalent of `gridText`)
**1. Tracker text** (`trackerText.ts`) is the main format, for both reading and writing.
- Channels are separated by `|`, and an optional row number allows sparse writes.
- Tokens are recognised by their shape, so their order doesn't matter:
  - notes: `C-4`, `C#4`, `Db4`
  - note off and release: `===` / `^^^`
  - instrument: `@3` or `@bass`
  - volume: `v12`
  - effects: three-character tokens like `047`, `4A2`, `W02`
```
channels: P1 | P2 | TR | NO
 0 | E-5 @lead v12 | C-4 @arp 037 | A-2 @bass | C-4 @kick
 4 | G-5           | .            | .         | C-4 @snare
 6 | A-5 4A2       | ===          | A-3       | C-4 @hat v6
```
- Parse errors say how to fix the problem, like `GridError` does. Example: `Line 3, channel TR: "v12": triangle has no volume on NES; remove it`. At most 12 issues are reported.
- Formatting a pattern and parsing the text back gives the same pattern.

**2. Melody string** (`melodyText.ts`) writes one channel, with lengths in rows:
`"@lead v12 E5:2 G5:2 A5:4 r:2 G5 F#5 E5:4 ~:4 {A4 C5 E5}:8 D5:4!4A2"`
- On a single-voice channel, a chord `{…}` becomes an arpeggio effect.
- `wrap:true` continues into the next order row.

**3. Drum steps** (`drumText.ts`) work like the gridText legend:
`{"channel":"NO","legend":{"K":"@kick","S":"@snare","h":"hat"},"steps":"K.h.S.h.K.KhS.h.","repeat":4}`
- If a legend value is a preset role (`hat` above), the instrument is added automatically.

### Chip profiles (`src/core/chips/`)
Each profile is a `ChipProfile { id, era, channels(cfg): ChannelDef[], defaultConfig, validate(song): Issue[] }`. A `ChannelDef` gives the channel's kind, its note range, the instrument kinds it accepts, its volume and pan capabilities, and the effects it allows.

| Chip | Channels and constraints |
|---|---|
| NES | P1, P2 pulse (duty via `Wxx`); TR triangle (no volume); NO noise (16 periods, 93-step mode); optional DM DPCM channel |
| GB | P1 (with sweep), P2 pulse; WV wave (32×4-bit, 4 volume levels); NO LFSR (15/7-bit); hard L/C/R pan only |
| Genesis | F1..F6 FM 4-op (F6 can be a DAC); S1..S3 SN76489 squares (lowest note MIDI 45); SN noise |
| SNES | V1..V8 sample voices with ADSR/GAIN and echo/FIR; 64 KB ARAM budget for BRR samples plus the echo buffer |
| PCE | C1..C6 32×5-bit wavetable; noise on C5/C6 only; 5-bit volume; 4-bit pan |

- **Rules on every chip:** one note at a time per channel, and only the instrument kinds and effects that channel allows.
- **Strict mode:** write tools reject violations, and each error message includes the fix (for example "transpose +12 or move to TR").
- **Relaxed mode:** violations become warnings.
- **Full report:** `analyze_song` lists every violation.

### Instruments (`src/core/instruments/`)
- **Macros:** FamiTracker-style per-tick sequences `vol`, `arp`, `pitch` and `timbre`, with loop and release points.
- **Instrument kinds:**
  - `nes-pulse`, `nes-tri`, `nes-noise`
  - `gb-pulse`, `gb-wave`, `gb-noise`
  - `psg`, `psg-noise`
  - `fm` (algorithm, feedback, AMS/PMS, 4 operators with AR/DR/SR/RR/SL/TL/KS/ML/DT/SSG)
  - `snes-sample` (sample, base note, ADSR or GAIN, echo)
  - `pce-wave`
  - `sample` (for NES DPCM, the Genesis DAC and PCE DDA)
- **Roles:** lead, bass, pad, strings, brass, pluck, bell, organ, arp, flute, choir, kick, snare, hihat, openhat, crash, tom, clap and sfx.
  - Roles drive preset lookup, the GM mapping used in MIDI export, chip conversion and the style context.
- **Preset bank:** about 15–25 named presets per chip, with ids like `genesis.bass.slap` and `nes.lead.duty25`.
  - `add_instrument({preset:'bass'})` picks the chip's default for the target channel.
  - Noise drums use a fixed arp macro, as FamiTracker users do.

### Synth engine (`src/core/synth/`)
The engine is pure TS and deterministic, and it allocates nothing in the hot path. The same `SongPlayer` runs in the worklet and in offline renders.

**Sequencer** (independent of the chip): for each tick it produces a `ChannelControl {trigger, gate, freqHz, vol, timbre, pan, inst}`. It applies macros and these effects:
| Category | Effects |
|---|---|
| Pitch | `0xy` arpeggio, `1xx`/`2xx` slides, `3xx` portamento, `4xy` vibrato, `Qxy`/`Rxy` note slides, `Pxx` fine pitch |
| Volume | `7xy` tremolo, `Axy` volume slide |
| Flow and timing | `Bxx`/`Cxx`/`Dxx` jump, halt and break; `Fxx` speed/BPM; `Gxx` note delay; `Sxx` note cut |
| Chip parameters | `Wxx` timbre, `Xxx` pan, `Exx` SNES echo |

**Timeline:** maps each (order, row) to a tick and a time, and detects the loop. The playhead, MIDI export and the WAV loop points all use it.

**Chip voices**
- **Square, triangle and wave chips** (NES, GB, PCE, PSG):
  - `blip.ts` is a minimal Blip_Buffer that band-limits the output steps the way the real hardware sounds.
  - Pitch is quantized to each chip's period register, which gives the authentic detune.
  - The LFSRs follow each chip: NES 15-bit with short mode, GB 15/7-bit, SN76489.
- **YM2612:**
  - Sine and exp tables, integer phase, dB envelopes, the eight algorithms, and OP1 feedback.
  - It aims for the right sound, not cycle accuracy.
- **SPC700:**
  - Runs internally at 32 kHz with BRR-decoded samples, 4-point Gaussian interpolation, ADSR/GAIN, and an echo ring buffer with an 8-tap FIR and feedback.
  - Echo is exported as its own stem.
- **SNES sample generation** (`samplegen/`): Nintendo samples can't be shipped, so they are generated.
  - Generators, all with a seeded PRNG:
    - additive single- and multi-cycle waveforms for strings, choir and organ
    - Karplus-Strong for plucked sounds
    - the FM engine rendered offline for bells and e-piano
    - drum recipes for kick, snare, hats and crash
  - Each sample goes through a real BRR encode/decode round trip, so it has the 4-bit grit.
  - Projects store only the recipe and its parameters. User samples are stored as PCM16.
  - The same sample bank feeds NES DPCM and the Genesis and PCE DACs.

**Mixer:** a buffer per channel (the stems), then trim and pan, the per-chip output filters (NES high-pass and low-pass, the GB capacitor), a soft limiter, and Int16 output with seeded dither.

**Rendering:** `renderSong(song, {sampleRate, loops, fadeOutSec, stems})` returns `{L, R, stems?, loopStart, loopEnd}`.
- For a seamless loop it renders intro + body + body and keeps intro + the second body. The loop seam then already contains the release and echo tails.

**In the renderer**
- `worklet.ts` plays the song in 128-frame blocks.
- Edits are debounced and hot-swapped into the running playback, keeping the playhead in place.
- The worklet reports its position about 30 times per second.
- Exports run in `renderWorker.ts`, which reports progress.

### Codecs
- **`midi.ts` export:**
  - Format: SMF type 1, PPQ 480.
  - Tempo map, key and time signatures, loop markers, and CC111 at the loop start.
  - One track per channel, with GM programs taken from the role or `inst.gm` (`gmMap.ts`).
  - Noise, DPCM and drum roles go to MIDI channel 10 as GM drum notes.
  - Arpeggios become fast notes or chords. Slides and vibrato become pitch bend.
- **`midi.ts` import:**
  - Quantizes the notes and maps channel 10 to the noise or drum channel.
  - Ranks melodic tracks into bass and lead and assigns them to channels.
  - Reduces polyphony to the top voice plus arpeggios, and removes duplicate patterns.
  - Returns a report of every assignment it made.
- **`wav.ts`:** PCM16 stereo with a `smpl` loop chunk (Godot, FMOD and Wwise read it), plus `LIST/INFO`. It reads WAV files too. Stems are named `<name>_<channelId>.wav`.
- **`project.ts`:** `.ctune` JSON `{format:'chiptune-studio', version:1, song, samples}`. Patterns are stored sparsely, and the format has a migration hook.

### Theory (`src/core/theory/`): data plus four tools; it does not generate music
| File | Contents |
|---|---|
| `scales.ts` | Modes, harmonic and melodic minor, pentatonics, blues, whole-tone, phrygian dominant, hirajoshi |
| `chords.ts` | Roman numerals to MIDI, chord to arpeggio parameter |
| `progressions.ts` | About 40 progressions tagged by mood |
| `drums.ts` | Step strings per style |
| `moods.ts` | One recipe per mood: BPM range, scales, progressions, channel roles, groove, chip-specific techniques, arrangement length |
| `analyze.ts` | Key detection, chords per bar, clashes |

The moods are heroic, battle, boss, spooky, dungeon, chill, town, overworld, victory, game over, title, shop, underwater, desert, castle and sad.

### Tools (about 48; RO = read-only)
| Group | Tools |
|---|---|
| song | `get_song` RO, `new_song`, `set_song_info`, `set_loop`, `list_chips` RO, `convert_chip`, `open_project`, `save_project` |
| channels and order | `update_channel`, `set_orders`, `insert_order`, `delete_order`, `duplicate_order`, `set_pattern_length` |
| notes | **`write_pattern`** (tracker text, merge or replace), `write_melody`, `write_drums`, `set_cells`, `clear_pattern`, `copy_pattern` (with transpose), `transpose` (semitones, or diatonic steps in the song's key) |
| reading | `read_pattern` RO (tracker or melody format), `render_preview` RO (piano-roll PNG plus a text summary), `analyze_song` RO |
| instruments | `list_presets` RO, `add_instrument`, `update_instrument`, `delete_instrument`, `get_instrument` RO, `list_samples` RO, `generate_sample` |
| theory | `get_mood_recipe`, `suggest_progression`, `get_scale`, `get_drum_pattern` (all RO) |
| assets (library) | `list_assets` RO (kinds: song, motif, instrument), `get_asset` RO, `save_as_asset`, `place_asset` (transposes to the song's key and adds the instruments it needs), `set_style_reference`, `get_style_context` RO |
| export | `export_wav` (loops, fade, stems, sample rate), `export_midi`, `import_midi` |
| playback | `play`, `stop` (go through `services.audio`) |
| history | `undo`, `redo` |

- **MCP resources:** `chiptune-studio://{guide,song,presets,assets}`.
- **MCP prompts:** `compose_track(mood, chip, length)`, `remix_to_chip`, `match_style`.

### LLM guide (`docs/llm-guide.md`, then `yarn gen:guide`)
- **Workflow:**
  1. `get_song`
  2. `get_mood_recipe`
  3. `new_song` (chip, BPM, key)
  4. Add instruments from presets.
  5. Write drums, then bass, then harmony and arpeggios, then the lead, with `write_pattern`, `write_melody` and `write_drums`.
  6. Build the order list (intro, A, B, loop).
  7. `analyze_song`
  8. `render_preview`
  9. `export_wav`
- **Reference sections:** chip cheat sheets (channels, idioms, limits), the effect reference, the mood table, and limits (keep each `write_pattern` call to 64 rows or fewer).
- **Short version:** the text between the short markers becomes the MCP `instructions`, at most 1500 characters.

## UI (`src/renderer/`)
- **Layout:**
  - Menu and transport bar: play/stop/loop, BPM, position.
  - Centre tabs: **Tracker** and **Piano Roll**.
  - Order list on the left.
  - Right-hand panels: Instruments, Library and Chat. All of them stay mounted while hidden, as in Pixel Studio.
- **Tracker:**
  - Virtualised grid of channels × rows with note, instrument, volume and effect columns.
  - Keyboard entry using FamiTracker key layout and octave keys; selection, copy and paste, transpose.
  - Mute and solo per channel; the playhead follows playback.
- **Piano roll:**
  - Shows one channel or all channels.
  - Draw, move and resize notes. Edits become `createCellsCommand` diffs.
  - The chip's note-range limits are shaded.
- **Instrument editor:** the controls depend on the instrument kind:
  - macro graphs
  - an FM operator panel with an algorithm diagram
  - a wave drawer for GB and PCE
  - an ADSR editor and a sample picker for SNES
  - a preset dropdown and "save to library"
- **Dialogs:** New Song (chip, mood, key), Export (WAV, stems, MIDI, loops and fade), Import MIDI, and Settings (Providers and MCP, copied).
- **Chat:** copied ChatPanel. Every agent edit is visible live, and "Undo agent turn" reverts the whole turn in one step.

## Milestones (each can be tested on its own)
1. **Scaffold:** copy the configs, scripts and infrastructure files and rename. Typecheck, lint, test, build and the Electron smoke test pass.
2. **Core:** model, commands and history, `notes.ts`, the three text codecs, chip profiles and validation, the `.ctune` project format, and the theory data.
3. **Synth part 1:** blip, LFSRs, sequencer, timeline, NES and GB voices, mixer, `renderSong`, and WAV with loop points.
4. **Tools and LLM:**
   - Registry and session; song, order, notes, reading, instrument, theory and `export_wav` tools.
   - Guide, bridge, agent runner and MCP server plus the stdio shim.
   - At this point the whole LLM loop works for NES and GB songs.
5. **UI:** tracker, piano roll, worklet playback with the playhead, instrument editor, transport, plus the copied Chat and Settings.
6. **PCE** wavetable voices and the **SN76489** PSG.
7. **YM2612 FM,** the Genesis preset bank and the DAC.
8. **SNES:** sample generation, BRR, Gaussian interpolation, ADSR/GAIN, echo and the ARAM budget.
9. **MIDI** export and import, stems and `convert_chip`.
10. **Library** and style references, `get_style_context`, `place_asset` with transposition, and the final e2e tests.

## Verification
- **Vitest, core:**
  - Format and parse round-trips for the tracker, melody and drum notations.
  - Snapshots of the error messages.
  - Command apply, invert and undo.
  - Chip validation.
- **Vitest, synth:**
  - **Sequencer:** a fake chip records the controls each tick (for example, `047` at speed 6 gives the notes C, E, G repeating).
  - **Pitch:** detect f0 for A-4, C-2 and C-6 on every voice kind, within the chip's quantization tolerance.
  - **LFSR periods:** 32767 and 93 for the NES, 127 for GB in 7-bit mode.
  - **FM:** a single operator under algorithm 7 is a clean sine; more feedback adds harmonics.
  - **SNES:** the BRR round trip meets an SNR threshold, and an echo impulse lands at the expected delay.
  - **Consistency:** rendering in 128-frame blocks gives exactly the same output as one offline render. Two renders are bit-identical.
  - **Golden files:** one SHA-256 hash per chip, refreshed with `UPDATE_GOLDEN=1`. When a check fails, the WAV is written to `.claude/temp/`.
  - **Performance:** `vitest bench` must render a 3-minute Genesis song in under 3 seconds.
- **Vitest, codecs:**
  - The WAV `smpl` chunk can be parsed back.
  - MIDI write, read and compare, plus a byte-for-byte fixture.
  - Stems add up to the master when the linear mix model is used.
- **Tools and MCP:** copied from Pixel Studio.
  - The registry runs against an in-memory session.
  - An SDK `Client` connects over `StreamableHTTPClientTransport` and calls `new_song`, `write_pattern` and `export_wav`.
  - The test checks the WAV header and `smpl` chunk.
- **LLM:** the copied fake-SSE client tests, plus the agent loop driven by the mock provider emitting `write_pattern` calls.
- **Playwright Electron:**
  - **Smoke test:** type notes in the tracker, then undo and redo.
  - **Export:** export a WAV and check its header.
  - **Integration:** call MCP `write_drums` on the running app, check that the session shows the cells, and check that one undo reverts that call.
- **Manual end-to-end (needs a real model):**
  1. In the chat, ask for *"heroic NES overworld theme, 120 BPM, 32-bar loop"*, then *"spooky SNES dungeon with echo"* and *"Genesis boss battle"*. Listen in the app, export WAV with a loop, and check that it loops seamlessly in a player that reads `smpl`. Undo the agent turn in one step.
  2. Connect Claude Code with `claude mcp add --transport http chiptune-studio http://127.0.0.1:7458/mcp`. Ask for a GB town theme in the style of a saved library song, and check that it calls `get_style_context`.

## Implementation tracking
- Branch: `chiptune-studio-llm-mcp` (from `origin/master` 78fd2f1). There is no ticket id; the `PICO-8` prefix on the folder came from the plan-to-ticket hook.
- Reference repo (read-only, never edit): `C:\projects\Personal\pixel-art-generator`.
- Execution phases (orchestrator):
  - [x] Phase 1: M1 scaffold (copy configs + infrastructure, rename, stub domain so it builds; smoke test)
  - [x] Phase 2: M2 core (model, commands, notes, text codecs, chip profiles, instruments + presets for NES/GB, theory, project) ∥ M3 synth part 1 (blip, lfsr, sequencer, timeline, NES/GB voices, mixer, render, wav)
  - [x] Phase 3: M4 tools + guide + agent/MCP rewiring ∥ M5 UI (tracker, piano roll, worklet playback, instrument editor, transport)
  - [x] Phase 4: M6 PCE + SN76489 ∥ M7 YM2612 FM + Genesis presets + DAC ∥ M8 SNES (samplegen, BRR, gauss, spc700)
  - [x] Phase 5: M9 MIDI export/import, stems, convert_chip ∥ M10 library + style references
  - [x] Final verification: gen:guide, typecheck, lint, test, build, test:electron

### Verification log

#### Phase 1 (M1 scaffold) - 2026-10-12
**Created**
- Configs: package.json (chiptune-studio, bin chiptune-studio-mcp, no gifenc, same dependency versions), .yarnrc.yml, .gitignore, .gitattributes, tsconfig.json/node/web (web excludes src/llm and src/main), electron.vite.config.ts, vite.mcp.config.ts, vitest.config.ts, playwright.electron.config.ts, eslint.config.mjs, electron-builder.yml, scripts/gen-guide.mjs + .d.mts, yarn.lock.
- Copied and renamed verbatim: src/llm/**, src/mcp-stdio/**, src/preload/index.ts, src/shared/{tools,ipc,mcp,agent,assets}.ts, seed/config/{providers,roles}.md (role artist -> composer, secondary role palette -> theory), src/main/{toolBridge,mcp,mcpSettings,mcpApp,llm,appSettings,chatHistory,agentIpc,services,index,agent,mcpContent}.ts.
- src/tools: registry.ts made generic over a `ToolSession` interface (transactionAsync, beginTurn, endTurn); services.ts reduced to fs/path services; memoryServices.ts, util.ts, session.ts (`StubSession`), defs/index.ts (empty tool list), index.ts, generated guideText.ts. docs/llm-guide.md is a placeholder with short markers.
- Renderer: App.tsx layout shell (transport bar, order list, Tracker | Piano Roll tabs, Instruments | Library | Chat tabs; all empty placeholders but Chat), ChatPanel, SettingsDialog, Controls, state/{chat,chatReducer,session,ui}.ts, lib/agentApi.ts, toolBridgeClient.ts, hooks/useSession.ts, styles.css (shell + controls + dialogs + chat + settings), chiptuneStudio.d.ts.
- Tests: tests/llm/**, tests/main/{agent,agentLlm,services,toolBridge}, tests/mcp/{helpers,server,settings,stdio}, tests/tools/{helpers,registry,guide,toolBridgeClient} (a fake write_pattern/get_song tool set replaces the pixel tools), tests/renderer/chatReducer, tests/sanity, tests/e2e/{launch,smoke.spec}.

**Commands**
- `yarn install`: pass.
- `yarn gen:guide`: pass.
- `yarn typecheck`: pass (node and web).
- `yarn lint`: pass (0 errors).
- `yarn test`: pass, 15 files, 142 tests.
- `yarn build`: pass (mcp stdio shim + electron-vite main/preload/renderer).
- `yarn test:electron`: pass, 4 Playwright tests (title, layout regions, `window.chiptuneStudio.invoke`, tab switching, Chat tab, Settings dialog).

**Deviations and decisions**
- registry.ts is generic: copied with the `EditorSession` type replaced by `ToolSession`; `ToolGroup` renamed to the music groups. `session.ts` (EditorSession) and `src/core/commands.ts` History were NOT copied: they are bound to Pixel Studio's Document. Phase 2 writes the music History/transactions and Phase 3 the real `SongSession`; until then `StubSession` (src/tools/session.ts) and the renderer's `PlaceholderSession` stand in.
- Deferred to Phase 3 (marked `TODO(Phase 3)`): tool definitions (defs/index.ts is empty), MCP resources song/presets/assets and the three prompts (only `chiptune-studio://guide` exists, no prompts), `ToolServices.audio`, the real guide text, `get_style_context` use in the agent (kept, runs only if the tool exists), the writing-tool list used by `withAutoPreview` (`isWritingTool`, names as planned).
- Deferred to Phase 5: src/main/assets.ts / assetsApp.ts and the Library panel (src/shared/assets.ts only has the new kinds song, motif, instrument). `src/main/index.ts` therefore does not start an asset service.
- Shared IPC: palette channels and `UserPaletteInfo` removed. Data root has the folders config, exports, projects, assets, chats, samples.
- tests/tools helpers use a fake tool set (`fakeTools()`), so the registry, bridge, MCP server, stdio shim and bridge-client tests exercise the real infrastructure without music tools.
- Smoke spec drops the Pixel Studio drawing/export tests; it covers the layout regions, the bridge API, tab switching, Chat and Settings.

#### Phase 2A (M2 core) - 2026-10-12
**Created (src/core)**
- `model.ts` (re-exports types; `createSong`, `patternKey/getPattern/peekPattern/patternAt`, `requireChannel/Instrument/Order` (+`*Index`/`find*` variants), `cloneSong`, `replaceSongContents`, `nextFreePattern`, `instrumentUsage`, timing helpers `rowSeconds/tickSeconds/ticksForRow/songRows/songTicks/songSeconds`, `summarizeSong`), `notes.ts`, `commands.ts` (History with transactions + composite, `createCellsCommand`, `createSetOrdersCommand`, `createInstrumentCommand`, `createSongInfoCommand`, `createChannelCommand`, `createSampleCommand`, `createPatternLengthCommand`, `createReplaceSongCommand`), `index.ts` (core exports, synth line left as a comment).
- `chips/{types,validate,nes,gb,genesis,snes,pce,index}.ts`: ChipProfile/ChannelDef for all five chips, generic validation engine (note range, instrument kind, volume, effects, fx columns, PCE noise only C5/C6, GB sweep only P1, GB wave volume quantization warning, Genesis PSG lowest note A-2 and DAC F6, SNES ARAM budget), `listChips`, `defaultChipConfig`, `requireChipId`, `formatIssues`.
- `instruments/{types,macros,validate,roles,index}.ts`, `presets/{types,nes,gb,index}.ts`: macro text form + validation, role metadata, instrument validation, 27 NES and 27 GB presets, `resolvePreset`; genesis/snes/pce banks are empty arrays for Phase 4.
- `theory/{scales,chords,progressions,drums,moods,analyze,index}.ts`: 16 scales, Roman numerals (major-relative, incl. bVII, V/V), chord symbols, `chordToArp`, 45 progressions, 21 drum styles, 16 mood recipes (all five chips), key detection (Krumhansl-Schmuckler), chord per bar, minor-second clashes, out-of-scale notes, channel stats.
- `codecs/{common,trackerText,melodyText,drumText,project}.ts`.
- Tests (`tests/core/`): helpers, notes, model, commands, chips, instruments, theory, trackerText, melodyText, drumText, project.

**Commands**
- `yarn typecheck`: pass (node + web).
- `yarn lint`: pass (0 errors).
- `yarn test`: pass, 30 files, 384 tests (Phase 2A: 10 files, 168 tests; the rest are Phase 1 and 2B).

**Deviations and decisions**
- Only additive change outside my files: none to `types.ts`.
- Extra files beyond the plan's list: `chips/validate.ts` (engine), `instruments/validate.ts`, `instruments/presets/types.ts`, `codecs/common.ts` (shared issue formatting and cell tokens).
- Timing contract used by `model.ts` matches the synth: tick = 60 / (bpm * rowsPerBeat * speed); a groove row lasts groove[i % len] ticks.
- Noise presets use a `fixed` arp macro whose values are noise pitch indices 0..15 (15 = highest), matching `noisePeriodIndex` in the synth.
- Genesis noise channel id is `NO` (not `SN`) so write_drums defaults work on every chip.
- Roman numerals are always relative to the major scale with explicit accidentals ("i bVI bIII bVII" in minor).
- Strict/relaxed: chip-rule violations carry severity `error` in strict songs and `warning` in relaxed ones; unknown instruments, out-of-range volume and bad effect parameters stay errors in both. The text parsers run the chip check only in strict mode and report every violation as a parse error.
- Name clash to resolve when exporting synth: `midiToHz` and `hzToMidi` exist in both `src/core/notes.ts` and `src/core/synth/tables.ts` (do not `export *` both from `index.ts`).

#### Phase 2B (M3 synth part 1) — 2026-10-12
- Files: `src/core/synth/{tables,blip,lfsr,flow,sequencer,timeline,mixer,player,render,index}.ts`, `src/core/synth/chips/{types,blipVoice,apu2a03,dmg,index}.ts`, `src/core/codecs/wav.ts`, `tests/core/synth/{fixtures,sequencer,blip-lfsr,pitch,synth}.test.ts` + `golden.json`, `tests/core/wav.test.ts`.
- `yarn vitest run tests/core/synth tests/core/wav.test.ts`: pass, 5 files / 74 tests. Perf: 64 s of a 5-channel NES song rendered in 133 ms at 44.1 kHz (`SKIP_PERF=1` skips it).
- Public API: `renderSong`, `SongPlayer` (block-size independent, allocation-free hot path, `seek`, `setMute`, `setSong` hot-swap, `position`), `buildTimeline`, `Sequencer`/`ChannelControl`, `registerVoice(chip|'*', kind, factory)` + `BlipVoice` base, `registerMixProfile`, `quantizeStereo`/`interleave`, `writeWav`/`readWav` (smpl + LIST/INFO).
- Deviations / limits: NES nonlinear mix is mono (stems only sum exactly with `mixModel:'linear'`). Not emulated: NES sweep unit/length counters, GB length counters/wave quirks; chip filters are one-pole approximations. `Sn76489Lfsr` taps need confirming in Phase 4. Effects are sticky until `xx00`; units documented in `sequencer.ts`. Unknown channel kinds (fm, sample, pce-wave, psg-*, dpcm) render silence until Phase 4.

#### Phase 2 integration (orchestrator) — 2026-10-12
- `src/core/types.ts` contract written by the orchestrator before 2A/2B ran in parallel.
- `src/core/index.ts` now re-exports `./synth` and `./codecs/wav`; `synth/index.ts` no longer re-exports `midiToHz`/`hzToMidi` (clash with `core/notes`; still available as `tables.*`).
- `yarn typecheck`: pass. `yarn lint`: pass. `yarn test`: pass, 30 files / 384 tests. `yarn build`: pass.

#### Phase 3 contract (orchestrator) — 2026-10-12
- `src/tools/session.ts` `SongSession` (port of Pixel Studio's EditorSession over Song: transactions, undo/redo with turn guard, `replaceSong`, beginTurn/endTurn merge, `cursor`, `octave`, `currentInstrument`), `ToolServices.audio: AudioService` in `src/tools/services.ts`, renderer `state/session.ts` creates the app session.

#### Phase 3A (M4 tools, guide, agent, MCP) — 2026-10-12
- Files: `src/tools/defs/{song,channels,order,notes,reading,instruments,theory,export,playback,history,index}.ts`, `src/tools/{editing,render,util,memoryServices,index}.ts`, `src/core/codecs/png.ts`, `docs/llm-guide.md` + generated `src/tools/guideText.ts`, `src/main/{mcpContent,agent}.ts`, tests `tests/tools/{song,order,notes,misc,e2e}.test.ts`, `tests/main/agentTools.test.ts`, `tests/core/png.test.ts` + updated helpers/counts.
- 37 tools (get_song, new_song, set_song_info, set_loop, list_chips, open_project, save_project, update_channel, set_orders, insert_order, delete_order, duplicate_order, set_pattern_length, write_pattern, write_melody, write_drums, set_cells, clear_pattern, copy_pattern, transpose, read_pattern, render_preview, analyze_song, list_presets, add_instrument, update_instrument, delete_instrument, get_instrument, get_mood_recipe, suggest_progression, get_scale, get_drum_pattern, export_wav, play, stop, undo, redo). Guide 20.6k chars, short 1420 chars.
- MCP resources `chiptune-studio://{guide,song,presets}`, prompts `compose_track`, `remix_to_chip`. `chipIsPlayable(chip)` = preset bank non-empty.
- Deviations: `read_pattern` also supports `format:"drums"`; auto-preview passes the written order range.

#### Phase 3B (M5 UI + realtime playback) — 2026-10-12
- Files: `src/renderer/audio/{protocol,worklet,audioEngine,renderWorker,renderClient}.ts`, `src/renderer/lib/{trackerGrid,trackerKeys,pianoRoll,exporter,files,audition,newSong,macroGraph,colors}.ts`, `src/renderer/state/{ui,audio,actions}.ts`, `src/renderer/hooks/useShortcuts.ts`, components `MenuBar, Transport, OrderList, TrackerView, PianoRoll, StatusBar, InstrumentsPanel, InstrumentEditors, MacroEditor, Dialogs, ExportDialog, Controls`, `App.tsx`, `main.tsx`, `styles.css`, `audioService.ts`, `toolBridgeClient.ts`, `electron.vite.config.ts` (`worker.format: 'es'`), tests `tests/renderer/{trackerKeys,trackerGrid,pianoRoll,exporter,audition}.test.ts`, `tests/e2e/editor.spec.ts`.
- Worklet loaded via `?worker&url` + `audioWorklet.addModule`; render Worker via `new URL(..., import.meta.url)`; edits hot-swapped into playback (debounced 120 ms on history changes).
- Deviations: `createIpcServices(api, audio?)` takes the audio service as a parameter (node tsconfig has no DOM); export progress is coarse (renderSong has no progress callback); mute/solo is player-level, not saved; instrument indices shown as hex in the UI. Not done: tracker row insert/delete shifting, drag-move of tracker selections; FM/SNES/PCE editors are the generic JSON editor until Phase 4.

#### Phase 3 verification (orchestrator) — 2026-10-12
- `yarn typecheck`: pass. `yarn lint`: pass. `yarn test`: pass, 42 files / 552 tests. `yarn test:electron` (build + Playwright): pass, 18 tests.
- Not run: `yarn dev`, listening tests, real LLM endpoints.

#### Phase 4 prep (orchestrator) — 2026-10-12
- Per-chip stub files so the three Phase 4 agents don't share edits: `src/core/instruments/presets/{genesis,snes,pce}.ts` (imported by `presets/index.ts`), `src/core/synth/chips/{huc6280,sn76489,ym2612,spc700,sample}.ts` (imported by `synth/chips/index.ts`), guide split into per-chip "(coming)" subsections. typecheck + 552 tests pass.

#### Phase 4A (PC Engine) — 2026-10-12
- Files: `src/core/synth/chips/huc6280.ts` (`PceWaveVoice` on BlipVoice, 12-bit divider, 5-bit volume, 16-level pan, noise on C5/C6 only), `src/core/instruments/presets/pce.ts` (27 presets + `PCE_WAVES`), `src/renderer/components/instruments/PceWaveEditor.tsx`, tests `tests/core/synth/pce.test.ts` (25) + `golden-pce.json`, `tests/tools/pce.test.ts` (3).
- Limits: volume linear (hardware is 1.5 dB steps); no LFO/DDA/master volume; noise rate/LFSR approximated.

#### Phase 4B (Genesis FM + PSG) — 2026-10-12
- Files: `src/core/synth/chips/ym2612.ts` (log-sin/exp tables, integer phase, real EG rate tables with key scaling, 8 algorithms, OP1 feedback, basic SSG-EG, LFO AMS/PMS, 9-bit DAC ladder grit, hard pan), `src/core/synth/chips/sn76489.ts` (PSG squares + noise; note->rate mapping documented), `src/core/instruments/presets/genesis.ts` (34 presets: FM bass/lead/brass/strings/keys/bell/pluck/flute/drums + PSG), `src/renderer/components/instruments/FmEditor.tsx` + `src/renderer/lib/fmLayout.ts`, tests `tests/core/synth/genesis.test.ts` (33) + `golden-genesis.json`, `tests/tools/genesis.test.ts` (5), `tests/renderer/fmEditor.test.ts` (2).
- Perf: 184.6 s of a 10-channel Genesis song renders in ~1.5 s at 44.1 kHz (target < 3 s for 3 min).
- LFSR: SN76489 taps (bit0 XOR bit3 into bit15, seed 0x8000) confirmed; white period from that seed is 57337 (not maximal), periodic 16.
- Limits: not cycle-accurate; no CSM/ch3 special mode; LFO PM is a plain triangle; LFO rate read at voice creation.

#### Phase 4C (SNES + generic sample voice) — 2026-10-12
- Files: `src/core/synth/samplegen/{gauss,brr,generators,bank,index}.ts` (21 seeded recipes, closed-loop BRR encode/decode, DPCM + 8-bit DAC), `src/core/synth/chips/spc700.ts` (8 voices @32 kHz, Gaussian interpolation, ADSR/GAIN rate tables, echo bus with FIR/feedback as an `_echo` stem), `src/core/synth/chips/sample.ts` (Genesis F6 DAC, NES DM DPCM), `src/core/instruments/presets/{snes,samples}.ts` (27 SNES + genesis.dac.* + nes.dpcm.*), `src/tools/defs/samples.ts` (`list_samples`, `generate_sample`), UI `instruments/{SnesSampleEditor,SampleEditor}.tsx`, `SnesEchoControls.tsx`, `lib/{snesEnv,snesEcho}.ts`, tests `tests/core/samplegen.test.ts` (12), `tests/core/synth/{snes (36),sample (6)}.test.ts` + `golden-snes.json`, `tests/tools/{samples (6),snes (4)}.test.ts`, `tests/renderer/snesEnv.test.ts` (5).
- Shared additive changes: `ChipVoice.setSong?/setMuted?/aux?` + player/mixer/render aux buses (echo stem); `missingPresetSample` + `addInstrumentWithSample` so presets add their sample slots in the same undo step; `estimateSampleLength` exact for recipes.
- Limits: Gaussian table entries 416-511 recomputed; BRR clamps instead of wrapping; per-voice envelope counters; no SNES noise/pitch-mod; PCE DDA not applicable (profile has no DDA channel). A hot-swapped new recipe sample is generated on the audio thread (small hiccup).

#### Phase 4 integration (orchestrator) — 2026-10-12
- Guide line-7 summary lists all five chips; MCP `compose_track` chip description updated; `write_drums` defaults to C6 on PC Engine and V8 on SNES (no noise channel); `add_instrument` params describe psg, pce-wave, fm, snes-sample and sample kinds; `yarn gen:guide`.
- `tests/e2e/editor.spec.ts`: string `page.waitForFunction` (blocked by the app CSP: needs eval) replaced by a `page.evaluate` polling helper.
- `yarn typecheck`: pass. `yarn lint`: pass. `yarn test`: pass, 53 files / 689 tests. `yarn test:electron`: pass, 18 tests.

#### Phase 5A (M9 MIDI + convert_chip) — 2026-10-12
- Files: `src/core/codecs/{gmMap,midiFile,midi,midiImport,slots,songBuild}.ts`, `src/core/convert.ts`, `src/tools/defs/midi.ts` (`export_midi`, `import_midi`, `convert_chip`), renderer `lib/midiIo.ts`, `state/midiActions.ts`, `components/{ImportMidiDialog,ConvertChipDialog}.tsx`, ExportDialog WAV|MIDI tabs, MenuBar buttons, guide `## MIDI`; tests `tests/core/{midi (26),convert (9)}.test.ts`, `tests/tools/midi.test.ts` (8), `tests/renderer/midiIo.test.ts` (6), `tests/e2e/midi.spec.ts` (3).
- Export follows the shared timeline (FF51 per Fxx, groove as unequal row lengths; seconds == `buildTimeline().introSeconds`), markers per order, loopStart/loopEnd + CC111, RPN ±12 pitch bend for slides/vibrato, drums on channel 10. Import: grid pick from {2,3,4,6,8}, role-based channel plan per chip, skyline + 0xy folding, pattern dedupe, loop from markers/CC111, report of every decision. Convert: all 20 chip pairs tested (no errors, ≥70% drum hits kept); macros/hand-made patches are not carried over (documented).
- Deviations: melodic channel merging not implemented (drop + report); opened/imported songs clear the project path so Save can't overwrite the source.

#### Phase 5B (M10 library + style references) — 2026-10-12
- Files: `src/main/{assets,assetsApp}.ts` (+ start in `index.ts`), `src/shared/assets.ts`, `src/tools/{assetOps,services,memoryServices}.ts`, `src/tools/defs/assets.ts` (`list_assets`, `get_asset`, `save_as_asset`, `place_asset`, `set_style_reference`, `get_style_context`), `src/main/mcpContent.ts` (`chiptune-studio://assets`, `match_style`), renderer `LibraryPanel`, `SaveAssetDialog`, `hooks/useAssets.ts`, `lib/{tools,assetForm}.ts`, `state/assetActions.ts`; tests `tests/tools/assets.test.ts` (20), `tests/main/assets.test.ts` (14), `tests/mcp/assets.test.ts` (3), `tests/renderer/assetForm.test.ts` (4), agent style-context cases, `tests/e2e/integration.spec.ts` (3: MCP client drives the running app, undo per call, save/place/reference/delete via the Library tab).
- Asset = `~/ChiptuneStudio/assets/<slug>/{asset.ctune, thumb.png, meta.md}`; motifs transpose chromatic or diatonic to the song key; cross-chip instruments resolve by role. Deviations: `createSetReferencesCommand` lives in `assetOps.ts`; `save_as_asset` is readOnly (no undo step), as in Pixel Studio.

#### Final verification (orchestrator) — 2026-10-12
- `remix_to_chip` MCP prompt updated to describe what `convert_chip` keeps and drops.
- `yarn gen:guide`: pass. `yarn typecheck`: pass. `yarn lint`: pass. `yarn test`: pass, 61 files / 782 tests. `yarn test:electron` (build + Playwright, isolated home + MCP port): pass, 24 tests.
- Demo through the real tool registry (`.claude/temp/demo.ts`, `npx tsx`): the guide's NES example composed with write_drums/write_pattern/write_melody, then `convert_chip` to gb/genesis/snes/pce and `export_wav` for each + `export_midi`. Output in `.claude/temp/demo/` (hero-{nes,gb,genesis,snes,pce}.wav, hero-nes.mid): all 7.3 s with an smpl loop, peaks 0.49–0.92, RMS −19.3 to −10.9 dBFS.
- Not run: listening by a human, real LLM endpoints (LM Studio/cloud), a Claude Code MCP session, `yarn dev`, `yarn dist` packaging.
