# Changelog

## 2026-10-28: MDI-10, synthwave on two sample chips (PS1 SPU and Dreamcast AICA)

Chiptune Studio has two new chips, `ps1` (PlayStation SPU) and `dreamcast` (Dreamcast AICA), built on a sampler core they share with the SNES. Both have synthwave presets made with samplegen. There are four new `compose_track` moods (`synthwave`, `outrun`, `darkwave`, `dreamwave`), UI controls for both chips, the MCP tool texts, MIDI export for more than 15 melodic channels, and the docs. SNES output is bit-identical to master. Committed on `MDI-10_synthwave-ps1-dreamcast`, one commit per phase (not pushed).

**Repo:** midi-generator. **Branch:** `MDI-10_synthwave-ps1-dreamcast`, from `master` @ 7d361fb. 106 files changed, +11387 / -471.

| Commit | Phase |
| --- | --- |
| `a2052ec` | Plan, and `.claude/director/` in `.gitignore` |
| `1c95501` | A. Shared sampler voice core (SNES output unchanged) |
| `80eb824` | B0. Scaffolding for both chips |
| `eb42dac` | B. PlayStation SPU chip |
| `2f2d0ac` | C. Dreamcast AICA chip |
| `1f4acb1` | E1. Renderer UI (plus the RAM-usage exports in `chips/index.ts` and `samplegen/index.ts`) |
| `8ff9ce2` | J. Every chip loop in the tests covers both chips |
| `18668b1` | D1. Synthwave recipes and presets |
| `df56c83` | D2. Synthwave moods in `compose_track` |
| `7c845a6` | E2. Tools, MIDI channel sharing, guide, README, ROADMAP |

### A. Sampler core (`src/core/synth/sampler/`)
- **`clock.ts`:** `catmull()` and `DspClock`, the DSP-rate to output-rate resampler that was inlined in the SNES code.
- **`playback.ts`:** `SamplePlayback`. It holds the PCM, the loop, the 4-sample history and the 12-bit pitch counter, and interpolates with `'gauss'` (the SNES table, unchanged), `'linear'` or `'none'`. `advance()` reports the end of a one-shot.
- **`bus.ts`:** the `SendBus` interface, `busAux` and `SharedBus` (one bus per song, made by voice 0).
- **`voice.ts`:** abstract `SamplerVoice<I>`.
  - Its `control()` template handles trigger, declick on retrigger, gate and release, and vol/pan/send.
  - Envelope hooks per chip.
  - Optional `preStep` / `postSample`. A subclass that overrides them gets a separate `stepHooked()` loop, so the plain `step()` stays small. A bigger `step()` made V8 inlining bimodal: +23% in half the runs.
- **`spc700.ts`:** `SpcVoice extends SamplerVoice` with the ADSR/GAIN code moved verbatim. `EchoBus implements SendBus`. Public exports are unchanged.
- **`samplegen/bank.ts`:** a sample-target registry, `registerSampleTarget(id, {process, userPcm?, bytes, userRate?})`. `SampleTarget` is now `string`. `tryPeekSampleLength` / `estimateSampleLength` take a `target` (default `'snes'`). `additiveLoop` takes an optional `targetRate`, and `RATE(def, max)` an optional max. The `snes|` / `raw|` cache keys are unchanged. An unknown target now throws; before, it was treated as raw.

### B0. Scaffolding
- **Types:** `'ps1'` and `'dreamcast'` are appended to `CHIP_IDS`. New `Ps1Config {voices, reverb {preset, depth, inputVol}}` and `DreamcastConfig {voices, dsp {preset, mix, time, feedback, chorusRate, chorusDepth, delayMs}}`. New instrument kinds `psx-sample` and `aica-sample`.
- **Profiles:** `chips/ps1.ts` and `chips/dreamcast.ts` build channels V1..Vn from `voices` (PS1 16|24, Dreamcast 16|32|64, default 16). The shared channel builder is `chips/sampleVoices.ts`. Aliases: `psx`, `playstation`, `playstation1`, `spu`, `dc`, `aica`, `segadreamcast`.
- **Validation hooks:** `ProfileSpec.instrumentOnChannel` (per-cell chip rules) and `registerInstrumentRule(kind, rule)`. `instSampleId(inst)` replaces the `snes-sample`/`sample` checks in `commands.ts`, `assetOps.ts`, `defs/samples.ts`, `chips/snes.ts` and `chips/validate.ts`.
- **Song model and schema:**
  - `voices` is structural: `new_song` only, refused by `set_song_info`.
  - `createSong` merges nested `chipConfig` objects field by field (echo, reverb, dsp).
  - The zod schemas cover both kinds and both configs.
- **Role layouts:** both chips use the same layout in `roles.ts`, `slots.ts` `PLANS` and `moods.ts` `chipPlan`: bass V1, lead V2/V3, pads V4..V6, arp V7, pluck V8, bell V9, brass V10, sfx V11, tom V12, kick V13, snare/clap V14, hats V15, crash V16.
- **Baseline preset banks:** `presets/ps1.ts` and `presets/dreamcast.ts` map `SNES_PRESETS` (same sample slots) through `snesToPsxAdsr` / `snesToAicaAeg`, using the shared `presets/snesTimes.ts`.
- **`chipIsPlayable`:** it needs the chip's voice module to call `markChipPlayable(chip)`, so a chip renders only once its voices exist. Until then `render_audio` and `export_wav` refuse it with the "not available yet" note.
- **Exporter:** `auxStemIds(song)` in `renderer/lib/exporter.ts` (snes `_echo`, ps1 `_reverb`, dreamcast `_dsp`).

### B. PlayStation SPU (`synth/chips/spu.ts`, `spuReverb.ts`, `samplegen/psxAdpcm.ts`, `chips/ps1.ts`)
- **PS-X ADPCM codec:** 16-byte blocks of 28 samples, filters 0..4, shifts 0..12 (13..15 decode as 9), and a closed-loop encoder.
  - Loops that are not whole blocks are resampled to whole blocks, and the sample rate is scaled by the same factor, so pitch is kept. Trimming instead detuned short loops by up to 27 cents.
- **`SpuVoice`:**
  - 44.1 kHz with Gaussian interpolation. Pitch is a 16-bit step with 0x1000 = 44.1 kHz, clamped at 0x4000.
  - The psx-spx ADSR: 15-bit level, linear and exponential modes, a slower exponential attack above 0x6000, and sustain direction.
  - `^^^` releases with the instrument's rate; `===` is a fast release.
- **Pitch modulation:** `pmod` reads voice n-1's output from a shared array on `SpuCore`. `pmod` on V1 is a validation error.
- **Noise:** `noise` uses one global LFSR, clocked by the last noise key-on. It advances once per DSP step, so renders are identical at every block size.
- **Reverb** (`_reverb` stem):
  - It follows the psx-spx algorithm at 22.05 kHz with saturating 16-bit math.
  - Resampling is a [1 3 3 1]/8 decimator in and linear interpolation out.
  - Presets: off, room, studio-small/medium/large, hall, half-echo, space-echo, echo, delay.
  - Instrument `reverb` sets the send; `Exx` overrides it.
- **SPU RAM:** `spuRamUsage(song)` totals ADPCM bytes, the reverb work area and 4 KB reserved, against 512 KB. The ARAM-style error names the fix.
- **Mix:** `linearGain` 0.22.

### C. Dreamcast AICA (`synth/chips/aica.ts`, `aicaDsp.ts`, `aicaTables.ts`, `samplegen/aicaAdpcm.ts`, `chips/dreamcast.ts`)
- **Formats:** `pcm16`, `pcm8` and Yamaha 4-bit ADPCM, picked per instrument by `format`. `AicaVoice.startNote` sets the voice's sample target per instrument, through a cast on the base class field.
- **`AicaVoice`:** 44.1 kHz with linear interpolation, and pitch from OCT plus 10-bit FNS.
- **Envelope (AEG):** runs in the attenuation domain with the documented 6-bit rate tables (AR/D1R/D2R/RR, DL, KRS).
- **LFO** (in `preStep`): LFOF frequency table; saw, square, tri or noise; pitch and amp depth; reset on key-on; noise from a seeded LFSR.
- **Filter** (in `postSample`, only when the instrument has one): a 2-pole resonant low-pass with Q and the FLV0..4 / FAR / FD1R / FD2R / FRR envelope.
- **Panning and volume:** DIPAN pan with 16 steps per side; TL volume in 0.375 dB steps.
- **Idle voices:** an inactive voice whose history is all zero only advances the clock arithmetic.
- **DSP** (`_dsp` stem, wet only): preset effects, not the 128-step microcode.
  - Freeverb-style reverb with 8 combs and 4 allpasses per side.
  - Chorus: two modulated taps per side.
  - Delay: stereo; echo is ping-pong.
  - Presets: off, room, hall, plate, chorus, chorus-hall, delay, echo, chorus-delay.
  - The send is `send` 0..15 (IMXL); `Exx` overrides it.
- **AICA RAM:** `aicaRamUsage(song)` totals samples by format plus the DSP ring buffer, against 2 MB.
- **Mix:** per-voice `linearGain` 0.25, with `aicaQuantizePan` as the mix profile's pan quantizer.

### E1. Renderer UI
- **`Ps1ReverbControls.tsx`:** preset, depth, input and an SPU RAM meter. **`DreamcastDspControls.tsx`:** preset, mix, time, feedback, delay, chorus rate and depth, and an AICA RAM meter. Both are in the Transport and edit through `setSongInfo`, the same command path as `SnesEchoControls`.
- **Instrument editors:** `instruments/Ps1SampleEditor.tsx` (sample, ADSR with times and a curve, reverb, pmod, noise) and `instruments/DreamcastSampleEditor.tsx` (format, sample, AEG, optional filter and LFO, send). The JSON editor is kept as a collapsed "advanced" view.
- **Voices select:** in the New Song, Convert and Import MIDI dialogs, via `lib/newSong.ts` and `lib/midiIo.ts` (`voicesConfig`, `convertVoices`).
- **Tracker:** `TrackerView.tsx` now scrolls the cursor channel into view horizontally; there was no horizontal scroll-into-view before. `styles.css`: the order list scrolls sideways as one block.
- **Helpers:** `lib/ps1Env.ts` and `lib/aicaEnv.ts` (envelope times, curves, preset labels, RAM meters).

### J. Join
- PS1 and Dreamcast are added to the hard-coded chip lists in `studio`, `sfx`, `midi` (core and tools), and to the every-chip-to-every-chip loop in `convert.test.ts`. Nothing failed.
- **`write_drums` default channel** (`defs/notes.ts`): on ps1/dreamcast it is the role's first `ROLE_CHANNELS` entry (kick V13, hat V15, ...). Mixed roles go to V14.
- **Convert report** (`core/convert.ts`): the first 10 dropped channels get a line each, and the rest are summarised in one line. Drum lines collapse above 6 source channels.

### D1. Synthwave recipes and presets
- **19 new recipes** in `samplegen/synth.ts`, registered at the end of `RECIPES`; the existing 21 are unchanged:
  - leads: `supersaw`, `sawlead`, `syncsaw`;
  - pad: `junopad`;
  - bass: `analogbass`, `fmbass`;
  - melodic: `synthpluck`, `synthbrass`, `dxepiano`, `dxbell`;
  - drums: `linnkick`, `808kick`, `linnsnare`, `gatedsnare`, `linnclap`, `linnhat`, `linnopenhat`, `linntom`, `linncrash`.
- **Recipe properties:** all seeded and deterministic. Loops are multiples of 112 samples (whole PS-X blocks) and at most 16352 samples.
- **Presets on both chips:** the 20 contract ids plus `<chip>.brass.synth-stab`. PS1 uses ADSR and the hardware reverb.
  - Dreamcast leads have LFO vibrato.
  - Dreamcast `bass.analog` and `brass.synth-stab` use the live filter envelope.
  - Dreamcast pads are `adpcm` with send 11-12; the drums are `pcm16`.
- **Budgets:** all 20 synthwave presets in one PS1 song use 164 KB of 512 KB with `studio-large`. On Dreamcast with `chorus-hall` they use 507 KB of 2 MB. Cold generation takes about 150-190 ms per chip, and the slowest preset (supersaw) under 50 ms.

### D2. Moods and composer
- **Moods** appended to `SEEDS`:

  | Mood | BPM | Default chip | Bass | Drums |
  | --- | --- | --- | --- | --- |
  | `synthwave` | 96-118 | ps1 | `drive` (8ths) | `synthwave-gated` |
  | `outrun` | 108-118 | dreamcast | `roll` (16ths) | `outrun-four` |
  | `darkwave` | 88-112 | ps1 | `drive` | `darkwave-pulse` |
  | `dreamwave` | 80-100 | dreamcast | `rock` (2 notes per bar) | `dreamwave-half` |

- **Aliases:** retrowave, synth, 80s; chase, drive; coldwave, goth; chillwave, dreamsynth. `dreamy` still maps to ambient.
- **Progressions:** `epic-minor` and `underwater-minor` are tagged for the new moods. New: `synth-drive`, `synth-rise`, `dark-pulse`, `dream-float`.
- **Composer:** everything is behind `SYNTH_MOODS`, and the new randomness comes from `createRng(seed ^ 0x9e3779b9 ^ 0x5357 ^ varMix)`.
  - On chips with 12+ voices:
    - a 16th-note arp over 2 octaves on V7;
    - 3 pads on V4..V6;
    - a lead double on V3, an octave down with `G02`;
    - outrun brass stabs on V10.
  - Chip FX:
    - PS1 reverb: `hall`; `space-echo` for dreamwave, `studio-large` for darkwave.
    - Dreamcast DSP: `chorus-hall`; `chorus-delay` for outrun, with a dotted-8th delay.
  - On the other chips the synth moods use role presets.

### E2. Tools, MIDI, docs
- **Tool texts:** `new_song`, `set_song_info`, `compose_track`, `compose_sfx`, `convert_chip`, `add_instrument`, `get_mood_recipe` and `list_chips` now cover 7 chips, the new moods and their default chips, and the `voices` / `reverb` / `dsp` examples.
  - `set_song_info` now validates a reverb/dsp patch before applying it.
  - `list_samples` / `generate_sample` show SPU and AICA RAM lines and a per-chip `add_instrument` hint, and list the 40 recipes.
- **MIDI export (`core/codecs/midi.ts`, `shareMelodicChannels`):** with more than 15 melodic channels:
  - each GM program gets its own MIDI channel first;
  - spare channels go to the next tracks;
  - the remaining tracks become guests on the same-program channel, or on the least-used one.
  - A guest writes only notes, with no program, CC or bend. `export_midi` lists the merges.
  - Exports with 15 or fewer melodic channels are byte-identical (11 pinned hashes from the old code, in `tests/core/midiFixtures.ts`).
- **Long songs in tool output (Risk 2):** on songs with more than 16 channels:
  - `get_song` collapses order rows and lists only channels with notes: 4.7 KB → about 1 KB on 64 voices.
  - `read_pattern` without `channels` reads only channels with notes. Worst case, 64 full channels, is 62 KB.
  - `list_chips` collapses runs of identical channels.
- **Docs:**
  - `docs/llm-guide.md` has PS1 and Dreamcast sections, the mood rows and the `E` row. The short section is 1496 of 1500 characters. `src/tools/guideText.ts` is regenerated.
  - README chip list and `compose_track` row.
  - ROADMAP MDI-10 paragraph with the approximations and follow-ups.

### Deviations from the plan
- **The demo song:** the A0 baseline uses the golden demo song from `snes.test.ts`; it is not in `fixtures.ts`.
- **`SamplePlayback`:** it exposes `advance()` + `interpolate()` + `pitchOffset` instead of a single `nextSample()`. Its config is a constructor argument (`SamplerConfig`), because the base constructor warms the sample cache.
- **Extra files:** `chips/sampleVoices.ts`, `presets/snesTimes.ts`, `synth/chips/aicaTables.ts`, `tests/core/midiFixtures.ts`.
- **PS1 ADPCM loops:** they are resampled to whole blocks rather than trimmed (pitch would drift).
- **PS1 Gaussian table:** the SNES `GAUSS` table is reused, because the psx-spx table could not be reproduced from memory.
- **Dreamcast DSP RAM:** delay presets go up to 192 KB, not 128 KB, because 1000 ms of stereo delay needs it.
- **`brass.stab`:** it already existed as the SNES-mapped stab, so the new synth stab is `<chip>.brass.synth-stab`. The outrun composer uses it; the orchestrator changed the composer and the test.
- **PS1 `snare.gated`:** it is dry (`reverb: false`), because the gate is baked into the sample.
- **Recipe params:** `analogbass` gained `subOct` and `syncsaw` gained `seed`.
- **Pads and arps in D2:**
  - With only V4..V6 for pads, the third pad plays the 7th instead of the 5th when the chord has one.
  - Darkwave arps are also 16ths on the big chips, as the plan's test requires.
  - `synth-night` was not added, because it would duplicate `epic-minor`.
- **Smoke port:** the live smoke used `--port 7468` instead of the default 7458, so it would not clash with a running app.

### Verification
- **Typecheck, lint, test:** `yarn typecheck`, `yarn lint` and `yarn test` pass after every phase. Final: 79 files, 1182 tests (master: 890). `yarn build` passes.
- **`yarn gen:guide`:** run twice, the output is identical apart from line endings (the repo's CRLF hook).
- **SNES bit-exactness:** `npx tsx .claude/temp/mdi10/snes-baseline.ts --check` prints `OK: all 50 hashes identical` after every phase. The 50 hashes cover every `snes.*` preset, 6 GAIN variants, 5 composer songs, and the demo song at 44.1/48 kHz with 128-frame blocks.
- **Goldens and pins:** `golden-snes`, `golden-genesis`, `golden-pce`, `golden.json` and `composerPin.test.ts` are unchanged. D2 also compared the old and new composer on 1920 songs (20 old moods × 7 chips + the default chip × 3 seeds × 4 option sets): all byte-identical.
- **SNES render time:** the A0 baseline was 657 ms, but the machine drifted during the day. In side-by-side runs, master was 726-788 ms and this branch 737-738 ms, about +1.5%.
- **Perf:**

  | Render | Share of real time |
  | --- | --- |
  | Dreamcast, 64 voices with 32 sounding, filter and LFO | 4.8% |
  | Dreamcast, 64 sounding | 8.2% |
  | PS1, 24 voices with pmod and space-echo | 3-4% |

- **Smoke renders:** peaks from -1.9 to -4.7 dBFS, no clipping.

  | File | Content |
  | --- | --- |
  | `.claude/temp/mdi10/ps1/smoke-ps1.wav` | hand-written PS1 song |
  | `.claude/temp/mdi10/dc/smoke-dreamcast.wav` | hand-written Dreamcast song |
  | `.claude/temp/mdi10/d2/synthwave-ps1-seed1.wav` | synthwave on PS1 |
  | `.claude/temp/mdi10/d2/outrun-dreamcast-seed1.wav` | outrun on Dreamcast |
  | `.claude/temp/mdi10/d2/darkwave-ps1-seed2.wav` | darkwave on PS1 |
  | `.claude/temp/mdi10/d2/dreamwave-dreamcast-seed3.wav` | dreamwave on Dreamcast |
  | `.claude/temp/mdi10/d1/*.wav` | 42 preset auditions |

- **Live MCP smoke:** `electron . --mcp-only --port 7468`, then `node .claude/temp/mdi10/mcp-smoke.mjs 7468`. All checks passed, and the server was stopped afterwards.
  - `tools/list` is unchanged.
  - `list_chips ps1` shows the voices and `psx-sample`.
  - `new_song` Dreamcast with 32 voices makes 32 voices.
  - `compose_track` synthwave goes to ps1.
  - The outrun `intro:2` loop starts at 4.248 s, which is 2 bars at 113 BPM.
  - `convert_chip snes` renders.
  - `compose_sfx` stinger on ps1 works.
  - Every ffprobe duration equals the reported one.

- **Live UI check (E1), done after the first changelog with the user's go-ahead.** It drove the built Electron app with Playwright (`.claude/temp/mdi10/ui/ui-check.spec.ts`, using the isolated launcher in `tests/e2e/launch.ts`) and saved screenshots in `.claude/temp/mdi10/ui/shots/`. All 6 steps pass:
  - **New Song:** PS1 offers 16/24 voices, and 24 gives V1..V24 with the reverb controls.
  - **PS1 synthwave (composed over MCP):** it plays in time (3.06 s of song in 3.0 s). Changing the reverb preset during playback applies, takes one undo step, and the RAM meter follows it.
  - **PS1 editor:** reverb and pitch mod save.
  - **Dreamcast outrun:** it plays in time, and the DSP preset change applies with one undo step. The editor shows the filter; the LFO toggle and the format change save.
  - **Dense 64-voice song:** every voice holds a supersaw or saw note. Song time kept pace with wall time (6.00 s in 6.00 s, ratio 1.000), so the AudioWorklet kept up.
  - **Tracker at 64 voices:** keyboard Tab reaches V64 and the view scrolls to it.
  - **Convert to PS1** with 24 voices works.
- **Bug found and fixed by the UI check (separate commit):** the tracker body drifted 1 px per channel against the header and cursor, 7.5 px at V8 and 68 px at V64. The header and cursor are laid out in `ch` units, but each body cell was its text width plus a 1 px border.
  - `styles.css` now draws the separator as an inset shadow.
  - `TrackerView.tsx` gives each cell its channel's `ch` width.
  - Measured drift is now 0.0 px on SNES, Genesis and a 64-voice Dreamcast song (`.claude/temp/mdi10/ui/align.spec.ts`).
  - The existing e2e `editor`/`smoke` specs pass (18 tests).
- **One console message per app run:** the tail of a CSP notice ("'script-src' was not explicitly set"). It most likely comes from the test harness's string evaluation, but this was not confirmed.

**Not run or not verified:**
- **Listening:** nobody has listened to any of the renders; only peak and RMS were measured.
- **Hardware data from memory:** the reference docs were not available during implementation.
  - PS1: the reverb preset register values; `half-echo`, `echo` and `delay` look inconsistent and should be checked first.
  - Dreamcast: the AEG anchor times and the LFOF table.
  - Dreamcast modelled values: PLFOS depths, KRS, FLV→Hz and Q scaling.

### Follow-ups and known limitations
- Check the PS1 reverb table and the Gaussian table against psx-spx, and the AICA tables against the AICA docs.
- **Risk 6:** sample generation happens in the voice constructor, which runs on the audio thread in the worklet, so loading a song can glitch. Warm the cache on the main thread before posting the song.
- Add a per-instrument target hook (`targetOf(inst)`) to `SamplerVoice` and remove the cast in `AicaVoice.startNote`.
- In the piano roll's "All channels" view, colours repeat every 8 channels. In the tracker, the row-number gutter is not sticky when scrolled sideways.
- The shared `SamplePicker` in `SampleEditor.tsx` still says "BRR bytes"; the new editors use their own `TargetSamplePicker`.
- In the sample editors the "Generate" recipe select starts at `strings`, not at the current slot's recipe.
- The status bar keeps the last action's message ("New PS1 song") after the song changes over MCP.

**Commit status:** committed on `MDI-10_synthwave-ps1-dreamcast` (10 commits, the last `7c845a6`); this changelog is in the commit after it. Not pushed, no PR.
