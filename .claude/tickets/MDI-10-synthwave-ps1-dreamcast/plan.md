# MDI-10: Synthwave with two sample chips, PlayStation SPU (`ps1`) and Dreamcast AICA (`dreamcast`)

Branch: `MDI-10_synthwave-ps1-dreamcast`, cut from `master` @ 7d361fb. Commit after each slice listed below, in the phase order. Do not push.
Commit messages: `MDI-10: <summary>`, ending with the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
Scratch files go in `.claude/temp/mdi10/`. The orchestrator writes `changelog.md` in this folder at the end, in the same style as MDI-05.

## Goal

Add synthwave support with two new **sample-based chips that share one sampler engine with the SNES**:

- **PlayStation SPU** (`ps1`): 24 voices, 4-bit PS-X ADPCM grit, a 44.1 kHz DSP, PS1 ADSR per voice, pitch modulation (PMON), a global noise generator, 512 KB of SPU RAM, and the SPU hardware reverb with the classic presets: Off, Room, Studio small/medium/large, Hall, Half Echo, Space Echo, Echo, Delay. The reverb follows the psx-spx algorithm and runs at 22.05 kHz.
- **Dreamcast AICA** (`dreamcast`): 64 slots and 2 MB of RAM. Sample formats are clean 16-bit PCM, 8-bit PCM and Yamaha 4-bit ADPCM. Each slot has an AEG (AR/D1R/D2R/RR/DL), an LFO for pitch and amplitude, and a resonant low-pass with a filter envelope. The DSP is modelled as reverb, chorus and delay presets; the real microcode is not emulated.
- Synthwave presets for both chips, all generated with samplegen (no sample files): detuned saw lead, supersaw pad, analog and FM bass, arp pluck, brass stab, DX e-piano and bell, a LinnDrum/808 kit with a gated-reverb snare, and toms.
- `compose_track` moods `synthwave`, `outrun`, `darkwave` and `dreamwave`, with recipes, progressions and drum styles. The new chips are their default chips.
- UI chip selection and per-chip controls, MCP tools, docs, README and ROADMAP, and tests.

## Context (read before starting)

- Chip contract: `src/core/chips/types.ts` (`ChannelDef`, `ChipProfile`). Registry: `src/core/chips/index.ts` (`CHIP_PROFILES`, `requireChipId` aliases). Generic validation: `src/core/chips/validate.ts` (`defineProfile`, `extra` hook for budgets, `estimateSampleLength`). The SNES profile and ARAM budget are in `src/core/chips/snes.ts`.
- Types: `src/core/types.ts` (`ChipId`, `CHIP_IDS`, `ChipConfig` union, `InstrumentKind`, `Instrument` union, `EffectCode` (`E` = SNES echo on/off), `SampleSlot`). Kinds per chip: `src/core/instruments/types.ts` (`KINDS_BY_CHIP`, `INSTRUMENT_KINDS`). Instrument validation: `src/core/instruments/validate.ts`. Project schema: `src/core/codecs/project.ts` (`instrumentSchema`, `chipConfigSchema`, both zod).
- Synth: one voice per channel, and a channel plays ONE note at a time. Voice contract and registry: `src/core/synth/chips/types.ts` (`ChipVoice`, `AuxOutput`, `registerVoice(chip, channelKind)`). Every voice module is imported from `src/core/synth/chips/index.ts`. The SNES voice is `src/core/synth/chips/spc700.ts` (`SpcVoice`, `EchoBus` as the aux `_echo`, 32 kHz DSP clock resampled with catmull per voice, gauss interpolation, 14-bit pitch with 0x1000 = native, ADSR/GAIN, declick on retrigger). The mixer (`src/core/synth/mixer.ts`) has `registerMixProfile`, `quantizePan`, and aux buses that it adds after the voices. The player (`player.ts`) renders voices in channel order per block, then the aux buses, and supports several aux buses (`auxIds`). Offline render: `render.ts`.
- Sequencer → voice: `ChannelControl` in `src/core/synth/sequencer.ts` (`trigger/gate/release/freqHz/vol/rawVol/pan/echo`). `E` sets `ch.echo`.
- Samples: `src/core/synth/samplegen/bank.ts` holds the recipes (`RECIPES`, `RATE` max 32000) and the pipelines (`SampleTarget = 'snes' | 'raw'`, `processForSnes`, `resolveSlot`, `tryPeekSampleLength` (SNES lengths), cache keys `snes|`, `raw|`). `brr.ts` is the BRR codec (closed-loop encoder). In `generators.ts`, `additiveLoop` picks a rate near 32000 with the hard-coded `/ 32000`; `karplusStrong`, `fmTone` and the drums are there too. `src/core/synth/samplegen/gauss.ts` is the 512-entry Gaussian table.
- Presets: `src/core/instruments/presets/*` (`PRESET_BANKS`, `Preset.sample` slot, `missingPresetSample`). The SNES bank is `presets/snes.ts`. Roles: `src/core/instruments/roles.ts` (`ROLE_CHANNELS`, `ROLE_CHANNEL_KINDS`, `ROLE_FALLBACKS`). The import/convert channel plan is `src/core/codecs/slots.ts` (`PLANS`). Conversion: `src/core/convert.ts` (generic over slots and presets). MIDI: `src/core/codecs/midi.ts` (`allocMelodic` caps at MIDI channel 15) and `midiImport.ts`.
- Theory: `src/core/theory/moods.ts` (`SEEDS`, `CHIP_IDIOMS`, `chipPlan` switch, `MOOD_ALIASES` where `dreamy` maps to `ambient`), `progressions.ts` (`PROGRESSIONS` tagged by mood; `epic-minor` is i-bVI-bIII-bVII), `drums.ts` (`DRUM_STYLES`, filtered by mood in array order; the composer uses `mood.drumStyles[0]`).
- Composer: `src/tools/composer.ts` (`DEFAULT_CHIP`, `CALM_MOODS`, `styleFor`, `softPresetRef`, `BASS_PATTERNS`, `planChannels` (at most 2 pads), `createRng`). `compose_sfx` is in `src/tools/sfx.ts`. The tools are `src/tools/defs/*`: `song.ts` (new_song, set_song_info, list_chips), `studio.ts` (compose_track, compose_sfx), `samples.ts` (list_samples, generate_sample with SNES-only hints and the ARAM block), `instruments.ts` (kinds doc string line ~36), `notes.ts` (write_drums default channel ~line 239), `midi.ts` (convert_chip/import_midi descriptions). `src/tools/util.ts` has `chipIsPlayable` (= the preset bank is non-empty).
- Renderer: the New Song dialog (`Dialogs.tsx`) and `ConvertChipDialog.tsx` list chips via `listChips()`, so they are generic. Chip-specific UI: `Transport.tsx` shows `SnesEchoControls` for SNES. `InstrumentEditors.tsx` has `SnesSampleEditor` and a JSON fallback editor. `lib/exporter.ts:64` counts stems with SNES-only `_echo`. `lib/newSong.ts` `STARTER_ROLES` covers the `sample` channel kind.
- Docs: `docs/llm-guide.md`, then `yarn gen:guide` writes `src/tools/guideText.ts`. **The short section is 1499 of 1500 characters**, so adding chips there means shortening other lines (`scripts/gen-guide.mjs` throws when it is over).
- Tests that loop over `CHIP_IDS` automatically and will pick up the new chips: `tests/core/chips.test.ts`, `model.test.ts`, `instruments.test.ts`, `theory.test.ts`. Tests with hard-coded chip lists: `tests/tools/studio.test.ts` `CHIPS`, `tests/tools/sfx.test.ts` `CHIPS`, `tests/core/midi.test.ts:470`, `tests/core/project.test.ts:72`, `tests/tools/midi.test.ts:148`. Golden hashes: `tests/core/synth/golden-snes.json` (SNES demo song, `UPDATE_GOLDEN=1` regenerates), `golden-genesis.json`, `golden-pce.json`, `golden.json`. Composer determinism pin: `tests/tools/composerPin.test.ts`.
- Hardware references: nocash **psx-spx** (SPU: ADPCM format and filters, ADSR register, pitch, PMON, noise, reverb registers, algorithm, presets and work-area sizes, Gaussian table) and the Dreamcast **AICA** register documentation (SCSP-derived: PCMS, OCT/FNS, AEG, FEG/Q, LFO, DISDL/DIPAN/IMXL/ISEL, RBL). Use them as specs only: **do not copy emulator source** (MAME, reicast/flycast, mednafen; their licences are not compatible with ours). Register-value tables taken from documentation are fine as data, with a comment that names the source.

## Decisions

The user decided items 1-4 on 2026-10-28. Items 5-7 are director defaults; the user can still change them.

1. **Voices** (user): `voices` is set per song when it is created: PS1 16 or 24, Dreamcast 16, 32 or 64, default 16 (details below).
2. **Moods** (user): all four, `synthwave`, `outrun`, `darkwave` and `dreamwave`. Default chips: synthwave and darkwave on `ps1`, outrun and dreamwave on `dreamcast`.
3. **PS1 reverb** (user): the documented hardware register values (the psx-spx preset table).
4. **Dreamcast per-voice resonant filter with its own envelope** (user): included (Phase C, item 2).
5. **Dreamcast effects** (default): fixed presets with a few parameters (`dsp` config below); no user-built effect chain.
6. **Conversion between SNES, PS1 and Dreamcast** (default): instruments are replaced by the target chip's role presets, which is the current documented rule. Sample slots and envelopes are not carried over.
7. **Channel names** (default): `V1..Vn` on both chips, as on the SNES.

Details:

- Chip ids `ps1` and `dreamcast`, labels `PS1` and `Dreamcast`. Aliases: `psx`, `playstation`, `playstation1`, `spu` → `ps1`; `dc`, `aica`, `segadreamcast` → `dreamcast`. `requireChipId` already strips spaces, `-` and `_`.
- Channel ids are `V1..Vn` on both chips, of channel kind `sample` (this reuses `registerVoice(chip, 'sample')`, preset `channelKinds: ['sample']` and the convert/drum rules for `sample`). Pan is `full`. Effects are the SNES list (`0 1 2 3 4 7 A P Q R S G X E` + flow). `E01`/`E00` toggles the voice's reverb (PS1) or DSP (Dreamcast) send, the same meaning as SNES echo. Update the `E` comment in `types.ts`.
- **Voice count is a structural chipConfig field `voices`**, set with `new_song` only (add it to `STRUCTURAL_CONFIG_KEYS` in `commands.ts`, like dpcm/fm6Dac). PS1 allows `16 | 24` (default 16); Dreamcast allows `16 | 32 | 64` (default 16). The hardware maximum is the largest value. Role tables use V1..V16, with drums on V13..V16, so every allowed count has the same default layout, and extra voices are free for doubling and polyphony. This keeps `get_song`, `read_pattern` and the tracker usable (see Risks).
- New instrument kinds:
  - `psx-sample` `{sample, baseNote, fine?, adsr: {attack 0..127, attackExp, decay 0..15, sustainLevel 0..15, sustainRate 0..127, sustainDir 'dec'|'inc', sustainExp, release 0..31, releaseExp}, reverb: boolean, pmod?: boolean, noise?: {shift 0..15, step 0..3}, macros?}`
  - `aica-sample` `{sample, baseNote, fine?, format: 'pcm16'|'pcm8'|'adpcm', aeg: {ar, d1r, d2r, rr 0..31, dl 0..31, krs? 0..15}, filter?: {q 0..31, flv: [5 x 0..8191], far, fd1r, fd2r, frr 0..31}, lfo?: {freq 0..31, pitchWave 'saw'|'square'|'tri'|'noise', pitchDepth 0..7, ampWave, ampDepth 0..7, reset: boolean}, send: 0..15, macros?}`
  Instrument kind names follow the hardware docs; the UI and the guide call them "PS1 sample" and "Dreamcast sample".
- chipConfig:
  - `Ps1Config {chip:'ps1', voices, reverb: {preset: Ps1ReverbPreset, depth 0..1 (vLOUT/vROUT), inputVol 0..1 (vLIN/vRIN)}}`, default preset `studio-large` with depth 0.5.
  - `DreamcastConfig {chip:'dreamcast', voices, dsp: {preset: 'off'|'room'|'hall'|'plate'|'chorus'|'chorus-hall'|'delay'|'echo'|'chorus-delay', mix 0..1, time 0..1, feedback 0..0.95, chorusRate 0..1, chorusDepth 0..1, delayMs 10..1000}}`, default `chorus-hall`.
  Both merge field-wise in `set_song_info` like SNES `echo`, which needs the special case in `model.ts:218` generalized for nested objects.
- RAM budgets are `extra` validators like ARAM. PS1: ADPCM bytes `ceil(n/28)*16` + reverb work area of the preset (psx-spx table) + 0x1000 reserved, against 512 KB. Dreamcast: bytes by format (2, 1 or 0.5 per sample) + DSP ring buffer by preset (16..128 KB), against 2 MB.
- Determinism: pure code with no `Math.random` and no wall-clock time. Noise and LFO noise come from seeded LFSRs. Renders must be bit-identical between runs and between 128-frame and offline block sizes, as the SNES tests check today.

## Rules for every slice

- **SNES, NES, GB, Genesis and PCE output must not change.** `golden-*.json` stay untouched; `UPDATE_GOLDEN` is never set for an existing chip. `composerPin.test.ts` stays green unchanged: new moods, progressions and drum styles must not change what existing moods draw. New progressions and styles may be tagged with new moods, and existing entries may gain new mood tags (the filters are per mood). Never insert entries ahead of existing ones in a way that changes an existing mood's filtered list.
- `compose_track` and `compose_sfx` without new arguments give the same songs for the existing moods and chips. `compose_sfx` defaults stay nes/snes.
- Every tool result still ends with one JSON text item (`okJson`). Match the style around the change: short comment headers, no extra abstractions beyond the sampler core.
- After each slice run `yarn typecheck`, `yarn lint` and `yarn test`, and all must pass before committing. `tests/core/synth/genesis.test.ts` "renders 3 minutes in under 3 s" is wall-clock sensitive (MDI-05 note). If it fails while the machine is loaded, rerun it alone before concluding anything.

## Phases and parallelism

```
A  sampler core refactor (SNES unchanged)       ─┐ sequential
B0 shared scaffolding for ps1 + dreamcast        ─┘ sequential (touches every shared registry file once)
        ├── B  PS1 SPU voice, ADPCM, reverb, budget, PS1 bank    ┐ parallel: disjoint files
        ├── C  AICA voice, ADPCM, DSP, budget, DC bank            │
        └── E1 renderer UI (controls, editors, exporter)          ┘ (E1 may start after B0)
J  join: hard-coded chip lists in tests, cross-chip fixes          sequential, after B + C
        ├── D1 synth recipes + synthwave presets (samplegen, presets/ps1.ts, presets/dreamcast.ts)  ┐ parallel, with the
        └── D2 moods, progressions, drum styles, composer synth style                               ┘ preset-id contract below
E2 MCP tool texts, samples tools, MIDI export channel sharing, docs, README, ROADMAP, gen:guide, live smoke   after D
```

Each parallel slice owns only the files listed under it. If a slice needs a change in another slice's file, it reports this and does not make the edit. B0 creates every shared hook (sample-target registry, voice import lines, profile files, preset bank files), so B and C never edit the same file.

---

## Phase A: shared sampler core, SNES unchanged

### A0. Baseline before any change (on the branch, before A1)
- Write `.claude/temp/mdi10/snes-baseline.ts` (run with `npx tsx`). It renders with `renderSong` and stores the sha256 of `quantizeStereo(...)` Int16 output in `.claude/temp/mdi10/snes-baseline.json`:
  - every `snes.*` preset: C-4 held 24 rows, then `^^^`, then C-5 with `===`, with echo on; also one preset with a GAIN envelope added by hand;
  - `composeSong` on SNES for `ambient` (seeds 1, 2), `title` (1), `battle` (1, chip snes), and one with `intro: 2`;
  - the golden demo song from `tests/core/synth/fixtures.ts` at 44.1 and 48 kHz, plus 128-frame block rendering through `SongPlayer.process`.
- Also store the timing of a 3-minute SNES compose render (median of 3 runs) for the perf comparison.

### A1. Extract the core
New folder `src/core/synth/sampler/`:
- `clock.ts`: `catmull()` and `DspClock` (the DSP-rate → output-rate catmull resampler that is now inlined in `SpcVoice.render` and `EchoBus.render`, with the same state `frac, a0..a3, k` and the same order of operations).
- `playback.ts`: `SamplePlayback`, which holds the pcm, len, loopStart, read pointer, the 4-sample history `h0..h3`, the 12-bit fraction pitch counter (`cnt + pitch`, 0x1000 = 1.0) and the interpolation (`'gauss'` uses `GAUSS` exactly as now; `'linear'` and `'none'` are new). `nextSample()` returns end-of-sample so the owner applies its own end rule (SNES: env to 0, voice off).
- `bus.ts`: the `SendBus` interface (`sendL/sendR` per DSP step, `steps`, `configure(song)`, `reset()`, `render(L, R, n)`), the shared-bus singleton pattern (`currentEcho` today), and the aux registration helper.
- `voice.ts`: abstract `SamplerVoice<I>` implementing `ChipVoice`. Its `control()` template handles trigger, declick-retrigger with `pending`, gate/release, vol/pan/send. It has `render()`, `reset()`, `setMuted()` and `setSong()` with sample warming. Hooks for subclasses: `instOf(inst)`, `sampleTarget`, `dspRate`, `interp`, `calcPitch(inst)`, `envStart/envStep/envRelease`, and an optional `preStep()` (pitch mod, LFO) and `postSample(s)` (filter).
- `spc700.ts` keeps its public exports (`SpcVoice`, `EchoBus`, `SNES_DSP_RATE`, `SNES_ECHO_STEP_FRAMES`, `SNES_RATE_PERIODS`, getters `envelopeLevel`, `pitchRegister`) and becomes `SpcVoice extends SamplerVoice` with its ADSR/GAIN envelope code moved verbatim. `EchoBus implements SendBus`.
- **Rule: move code, don't rewrite the math.** Keep every floating-point expression and its order of operations, e.g. `s * (this.env / 2047) * this.vol` and `(GAUSS[...] * h0 + ...) / 2048 / 32768`. Hot loops stay monomorphic: one subclass per chip, no closures per sample.
- Unit tests in `tests/core/synth/sampler.test.ts`: `DspClock` passes a constant through; `SamplePlayback` loops at `loopStart` and reports a one-shot end; the gauss and linear interpolators keep DC.

### A2. Sample-target hook (no output change)
- `bank.ts`: change `SampleTarget` to `string` and add `registerSampleTarget(id, {process(raw, opts): SampleResult, userPcm?: (raw) => SampleResult, bytes(samples): number})`. `'snes'` and `'raw'` register the current code paths, and the cache keys keep their current `snes|` / `raw|` prefixes. `tryPeekSampleLength(slot, target = 'snes')` and `estimateSampleLength(slot, sizes, target = 'snes')` get the target as a parameter whose default keeps today's behaviour.
- `additiveLoop` gets an optional `targetRate` (default 32000) in place of the literal, and the `RATE` param helper gets an optional max. Existing recipes stay unchanged.

**Phase A status (implemented, not committed):** A0, A1 and A2 done.
- A0: `.claude/temp/mdi10/snes-baseline.ts` + `snes-baseline.json` (50 hashes: every `snes.*` preset, 6 GAIN-envelope variants, 5 composer songs, the demo song at 44.1/48 kHz, 128-frame blocks, a looped demo, the 3-minute compose render). 3-minute render median 657 ms before.
- A1: `src/core/synth/sampler/{clock,playback,bus,voice}.ts`; `spc700.ts` is now `SpcVoice extends SamplerVoice`, `EchoBus implements SendBus`. Baseline `--check`: all 50 hashes identical; `golden-snes.json` untouched; 3-minute render median 672 ms (+2.3%).
- A2: `bank.ts` `registerSampleTarget`/`getSampleTarget`/`sampleTargetBytes`, `SampleTarget = string`; `target` parameter on `tryPeekSampleLength` and `estimateSampleLength`; `additiveLoop` `targetRate`; `RATE(def, max = 32000)`.
- Deviations: (1) `SampleTargetDef` has an extra optional `userRate` (rate user PCM is resampled to) so `estimateSampleLength` can estimate pcm slots per target without running the pipeline; 'snes' = 32000. (2) `SamplePlayback` has a `pitchOffset` (added to the pitch for one step) as the pitch-mod/LFO hook, and `advance()` + `interpolate()` instead of one `nextSample()`. (3) `SamplerVoice` takes a `SamplerConfig` constructor argument instead of overridable `dspRate/interp/sampleTarget` properties (the base constructor warms samples, so subclass fields would not be set yet). (4) Perf: V8 inlining of the per-step path was bimodal (+23% in half the processes) while `interpolate()` held all three modes; keeping only the gauss path in `interpolate()` (others in `interpolateSimple()`) and a separate `stepHooked()` for chips overriding `preStep`/`postSample` made it stable (+2%).

**Done when** `yarn typecheck && yarn lint && yarn test` pass with `golden-snes.json` unchanged, `.claude/temp/mdi10/snes-baseline.ts` reproduces `snes-baseline.json` exactly, and the 3-minute render time is within +15% of the A0 baseline.
Commit: `MDI-10: Shared sampler voice core (SNES output unchanged)`.

---

## Phase B0: scaffolding for both chips (shared files, done once)

- `types.ts`: `ChipId` / `CHIP_IDS` gain `'ps1', 'dreamcast'`, appended at the end so existing order and indices stay. Add the `Ps1Config` and `DreamcastConfig` types, the two instrument kinds and interfaces, and the updated `E` comment.
- `chips/ps1.ts` and `chips/dreamcast.ts`: profiles with channels from `voices`, `defaultConfig`, notes, and a description. `extra` budget validators are stubs returning `[]` (B and C fill them). Register them in `chips/index.ts` with the aliases.
- `instruments/types.ts`: `INSTRUMENT_KINDS`, `KINDS_BY_CHIP` (`ps1: ['psx-sample']`, `dreamcast: ['aica-sample']`). `instruments/validate.ts`: range checks for both kinds, plus `pmod`/`noise` shape checks (channel rules come in B). The missing-sample check in `chips/validate.ts` and `missingPresetSample` accept the new kinds (`'sample' in inst`-style helper `instSampleId(inst)`). Use that helper in `commands.ts:704`, `assetOps.ts:292`, `defs/samples.ts:30` and `chips/snes.ts` as well.
- `codecs/project.ts`: zod schemas for both kinds and both configs. Old `.ctune` files still load.
- `model.ts`: generic nested-object merge for chipConfig (SNES `echo`, PS1 `reverb`, DC `dsp`). `commands.ts`: `voices` is structural.
- `roles.ts` `ROLE_CHANNELS` / `ROLE_CHANNEL_KINDS` for both chips (identical layouts): bass V1, lead V2/V3, pad V4/V5/V6, strings V5/V4, choir V6, organ V5, arp V7, pluck V8/V7, bell V9, brass V10/V2, flute V2, sfx V11, tom V12, kick V13, snare V14, clap V14, hihat V15, openhat V15, crash V16. `slots.ts` `PLANS`: bass V1, lead V2, harmony V3..V12, drumLow V13, drumHigh V14, drumChannels V13..V16, spare V15/V16.
- `moods.ts`: `CHIP_IDIOMS` and the `chipPlan` cases for both chips, using the same layout: bass V1, lead V2, lead double V3, pads V4-V6, arp V7, counter or pluck V8, kick V13, snare V14, hats V15, toms/crash V16.
- `presets/ps1.ts` and `presets/dreamcast.ts`: **baseline banks** built from `SNES_PRESETS` by a mapper (same recipe slots, so the same sounds). `snesToPsxAdsr` and `snesToAicaAeg` approximate each preset's attack and sustain times, and SNES `echo` becomes `reverb`/`send`. Ids `ps1.<role>.<name>` and `dreamcast.<role>.<name>`. This gives every role a preset now, so the `CHIP_IDS` loops, compose and sfx can work. Register them in `PRESET_BANKS`.
- Sample targets: `samplegen/psxAdpcm.ts` and `samplegen/aicaAdpcm.ts` are created as modules that register `'psx'` and `'aica16' | 'aica8' | 'aica-adpcm'` with **pass-through** processors (B and C replace the bodies).
- Voice modules: create `synth/chips/spu.ts` and `synth/chips/aica.ts` with `registerVoice('ps1'|'dreamcast', 'sample', …)` returning `SilentVoice`, and import them in `synth/chips/index.ts`.
- `src/core/index.ts` exports. `exporter.ts:64` uses a generic aux-stem count helper (`auxStemIds(song)`: snes `_echo`, ps1 `_reverb`, dreamcast `_dsp`). This one line is in B0 so that E1 does not wait.
- Tests: `chips.test.ts` (7 chips listed, channel counts 16/24 and 16/32/64, invalid `voices` → error, aliases), `model.test.ts` (createSong for both, `voices` structural in set_song_info), `project.test.ts` round trip with the new kinds and configs, `instruments.test.ts` (validation messages for bad ADSR/AEG ranges).

- `tools/util.ts`: `chipIsPlayable(chip)` = the preset bank is non-empty **and** the chip is in a playable set filled by `markChipPlayable(chip)` (exported from `synth/chips/types.ts`). The set starts with nes, gb, genesis, snes and pce, so no existing voice file changes. B and C call it from `spu.ts` and `aica.ts`, so until then `render_audio` and `export_wav` refuse these chips with the "not available yet" note instead of writing silence.

**Done when** typecheck, lint and test pass, and songs on both chips can be created, edited, validated and saved, while rendering is refused with the not-ready note.
Commit: `MDI-10: Scaffolding for the PS1 and Dreamcast chips`.

---

## Phase B: PlayStation SPU (parallel with C and E1)

Owned files: `src/core/chips/ps1.ts`, `src/core/synth/chips/spu.ts`, new `src/core/synth/chips/spuReverb.ts`, `src/core/synth/samplegen/psxAdpcm.ts`, `src/core/instruments/presets/ps1.ts` (mapper tuning only), new `tests/core/synth/ps1.test.ts`, new `tests/core/synth/golden-ps1.json`.

1. **PS-X ADPCM codec** (`psxAdpcm.ts`): 16-byte blocks of 28 samples (shift/filter byte, flag byte with loop-start/loop/end, 14 data bytes). Filters 0..4 with coefficients (0,0) (60,0) (115,-52) (98,-55) (122,-60) / 64, shift 0..12 (and psx-spx's rule for 13..15). The encoder is closed-loop like `brr.ts` and searches filter × shift per block on the decoded output. The `'psx'` target keeps the native rate, aligns `loopStart` down to 28-sample blocks and trims the loop to whole blocks. User PCM above 48 kHz is resampled to 44.1 kHz. `bytes(n) = ceil(n/28)*16`.
2. **Voice** `SpuVoice extends SamplerVoice` (`spu.ts`): DSP rate 44100 and gauss interpolation (use the psx-spx table and reuse `GAUSS` if it is identical; add a test either way). Pitch is the 16-bit step with 0x1000 = 44.1 kHz, clamped at 0x4000. The PS1 ADSR runs per psx-spx: 15-bit level, shift/step rate formula, linear or exponential modes, exponential attack slowed above 0x6000, decay always exponential, sustain direction, release. Volume per side is 15-bit from cell vol × pan. `^^^` releases with the instrument's release, and `===`/cut uses a fast release.
3. **Pitch modulation** (`pmod`): voice n scales its step by voice n-1's current output (`step * (1 + out[n-1]/32768)`), read from a shared per-step array on the SPU core object (same singleton pattern as the echo bus, filled in channel order). Strict-mode validation: an instrument with `pmod` on V1 is an error ("V1 has no previous voice to modulate it; move it to V2..").
4. **Noise** (`noise`): one global noise LFSR per chip, clocked by the shift/step of the last key-on that used noise (hardware has one NOISE clock). The voice outputs noise × ADSR instead of the sample.
5. **Reverb** (`spuReverb.ts`, `SendBus`, aux id `_reverb`): psx-spx algorithm at 22.05 kHz with same-side and different-side reflections, early comb echoes, APF1 and APF2, input/output volumes, and a work area sized per preset. The register table for `room`, `studio-small`, `studio-medium`, `studio-large`, `hall`, `half-echo`, `space-echo`, `echo`, `delay` and `off` comes from psx-spx (data, with the source in a comment). Down- and up-sampling 44.1 ↔ 22.05 kHz: a short symmetric FIR or averaging and linear interpolation. Document this choice in the file header (accuracy versus cost). Use integer-style saturating 16-bit math so the hardware's grit is kept. Per-voice send = instrument `reverb`, overridden by `Exx`. A muted channel does not feed the reverb, as on SNES.
6. **Mix profile** `registerMixProfile('ps1', {outputGain, filters: () => []})`, with `linearGain` tuned so 8 full voices plus reverb peak around -3 dBFS.
7. **SPU RAM budget** (`chips/ps1.ts` `extra`): samples (`psx` lengths) + reverb work area + 4 KB reserved, against 512 KB. Errors and warnings are worded like ARAM ("lower the reverb preset to studio-small (saves N KB) or drop the largest sample …"). Also `spuRamUsage(song)` for tools and UI.
8. Call `markChipPlayable('ps1')` and tune the baseline bank's mapped ADSRs by ear, so attack and release match the SNES originals within about 20%.

Tests (`ps1.test.ts`): ADPCM round trip (byte size, loop alignment, SNR > 25 dB on the strings recipe, decoder on hand-made blocks); pitch (base note and ±12 in tune, clamp at 0x4000); ADSR (attack time for a linear and an exponential rate, decay to sustain level, release); noise is deterministic and active only with `noise`; pmod changes the pitch only on V2+ with a modulator present, and the V1 validation error; reverb (an impulse gives an identical response twice, `off` gives a silent `_reverb` stem, each preset has a tail, `echo`/`delay` have their first repeat at the documented delay ±1 ms, stems + `_reverb` = master in the linear model); budget accepts the demo and rejects an oversized song with the fix; block parity (128-frame vs offline bit-identical); golden hash `golden-ps1.json` of a demo song (lead, pad, bass, drums, reverb on).

**Done when** typecheck, lint and test pass, `ps1.test.ts` is green, and the smoke render (see Verification) of a hand-written PS1 song sounds right and is not silent (peak > 0.05).
Commit: `MDI-10: PlayStation SPU chip: ADPCM voices, ADSR, pitch mod, noise, hardware reverb`.

---

## Phase C: Dreamcast AICA (parallel with B and E1)

Owned files: `src/core/chips/dreamcast.ts`, `src/core/synth/chips/aica.ts`, new `src/core/synth/chips/aicaDsp.ts`, `src/core/synth/samplegen/aicaAdpcm.ts`, `src/core/instruments/presets/dreamcast.ts` (mapper tuning only), new `tests/core/synth/dreamcast.test.ts`, new `tests/core/synth/golden-dreamcast.json`.

1. **Formats** (`aicaAdpcm.ts`): `aica16` is raw, `aica8` is 8-bit quantized, `aica-adpcm` is a Yamaha 4-bit ADPCM round trip (adaptive step table per the AICA/YMZ docs; deterministic encoder). `bytes` = 2, 1 or 0.5 per sample. The instrument `format` picks the target.
2. **Voice** `AicaVoice extends SamplerVoice`: DSP rate 44100, **linear** interpolation, and pitch from OCT (-8..7) + FNS (10-bit), quantized so it matches the hardware's slight detune. The AEG runs in the attenuation domain with AR/D1R/D2R/RR rates, DL and optional KRS (rate table from the docs). The **LFO** is per voice (LFOF frequency table, saw/square/tri/noise, pitch depth PLFOS and amp depth ALFOS, reset on key-on, noise from a seeded LFSR). The **FEG filter** is a 2-pole resonant low-pass per voice (Q) with FLV0..FLV4 levels and its own rates. This filter is the key synthwave tool for brass swells and bass plucks; with no `filter` field the voice skips it entirely. Pan is quantized to the DIPAN 16 steps per side (mix profile `quantizePan`). Cell vol maps to TL attenuation.
3. **Fast path**: an inactive voice fills zeros and skips the envelope, LFO and filter. Check the cost: 64 voices with 32 active.
4. **DSP** (`aicaDsp.ts`, `SendBus`, aux id `_dsp`): a preset effect chain. Chorus is 2 modulated delay lines, stereo. Reverb is a deterministic FDN or Freeverb-style network with damping. Delay is stereo feedback and ping-pong for `echo`. Presets: `off`, `room`, `hall`, `plate`, `chorus`, `chorus-hall`, `delay`, `echo`, `chorus-delay`. Parameters come from `dsp` (mix, time, feedback, chorusRate, chorusDepth, delayMs). The per-voice send is `send` (0..15, IMXL), overridden on/off by `Exx`. The file header says the real 128-step microcode is not emulated and that these are period-typical effects.
5. **AICA RAM budget** (`extra`): samples by format + ring buffer per preset, against 2 MB. Plus `aicaRamUsage(song)`.
6. Mix profile and gain, `markChipPlayable('dreamcast')`, tuning of the baseline bank mapping.

Tests (`dreamcast.test.ts`): formats (pcm16 bit-exact, pcm8 quantization error bound, ADPCM SNR > 20 dB and byte count); FNS pitch in tune within the quantization error; AEG attack and decay times for a few rates; LFO pitch depth (measured vibrato range) and amp depth; filter (high-frequency energy drops with a low FLV, resonance peak with a high Q); DSP (identical impulse responses, `off` silent `_dsp`, delay repeat at `delayMs` ±1 ms, chorus does not change the dry pitch centre); budget; block parity; **perf**: a 64-voice song with 32 voices sounding renders 20 s in less than 25% of real time on this machine (a loose bound, documented as wall-clock sensitive); golden hash `golden-dreamcast.json`.

**Done when** typecheck, lint and test pass, `dreamcast.test.ts` is green and the smoke render is audible.
Commit: `MDI-10: Dreamcast AICA chip: PCM/ADPCM slots, AEG, LFO, filter, DSP effects`.

---

## Phase E1: renderer UI (parallel with B and C after B0; final check after D)

Owned files: new `src/renderer/components/Ps1ReverbControls.tsx`, new `DreamcastDspControls.tsx`, new `src/renderer/components/instruments/Ps1SampleEditor.tsx` and `DreamcastSampleEditor.tsx`, `Transport.tsx`, `InstrumentEditors.tsx`, `src/renderer/lib/` helpers (e.g. `ps1Env.ts`, `aicaEnv.ts` with time-to-rate helpers like `snesEnv.ts`), `styles.css`, renderer tests.

- The New Song dialog already lists chips from `listChips()`. Add a "Voices" select when the chip has `voices` options (16/24, 16/32/64), passed as `chipConfig` (check `newSong` in `state/actions.ts` and `lib/newSong.ts`). The Convert dialog gets the same select.
- Transport: `song.chip === 'ps1'` shows `Ps1ReverbControls` (preset dropdown, depth, SPU RAM meter); `'dreamcast'` shows `DreamcastDspControls` (preset, mix, time, feedback, RAM meter). Both edit through the same command path as `SnesEchoControls`.
- Instrument editors: sample picker, ADSR (PS1) and AEG/filter/LFO (Dreamcast) fields with readable times, reverb/send, format (Dreamcast), pmod/noise (PS1). The JSON fallback stays as the "advanced" view.
- Check the tracker with 24 and 64 channels: horizontal scroll, header ids, channel colours (`colors.ts` cycles), keyboard navigation and the piano roll. Fix layout only if broken.
- Tests: helper unit tests (`tests/renderer/ps1Env.test.ts`, `aicaEnv.test.ts`); `tests/renderer/exporter.test.ts` stem count for ps1 and dreamcast.

**Done when** typecheck, lint and test pass, and `yarn dev` shows: new PS1 and Dreamcast songs, reverb/DSP controls change the sound live, instrument editors save, and 64 channels scroll. Check this manually or with the `run` skill and a screenshot.
Commit: `MDI-10: UI for PS1 reverb, Dreamcast DSP and their sample instruments`.

---

## Phase J: join after B and C (sequential, small)

- Add `'ps1'` and `'dreamcast'` to the hard-coded chip lists in `tests/tools/studio.test.ts`, `tests/tools/sfx.test.ts`, `tests/core/midi.test.ts:470`, `tests/core/project.test.ts:72` and `tests/tools/midi.test.ts:148`. Fix what fails, in their owners' files: e.g. sfx tones that need a role fallback, drum notes on `sample` channels, composer pads on 16-voice chips.
- `write_drums` default channel (`defs/notes.ts:239`): for ps1/dreamcast it is the role's first `ROLE_CHANNELS` entry (kick V13, snare V14, ...), and the default with mixed roles is V14. SNES and PCE are unchanged.
- `convert.test.ts`: snes → ps1 (V-to-V by role, sample slots added, echo → reverb send), ps1 → dreamcast, dreamcast 64 → nes (drops reported), genesis → dreamcast, nes → ps1. Round trips keep the note counts of the kept channels.

**Done when** typecheck, lint and test pass with all seven chips in every chip loop.
Commit: `MDI-10: Every chip loop in the tests covers PS1 and Dreamcast`.

---

## Phase D: synthwave presets and moods (D1 ∥ D2)

### Preset id contract (D2 may reference these before D1 lands)
For both chips, `<chip>` = `ps1` | `dreamcast`:
`<chip>.lead.saw-detuned`, `<chip>.lead.sync`, `<chip>.pad.supersaw`, `<chip>.pad.juno`, `<chip>.bass.analog`, `<chip>.bass.fm`, `<chip>.bass.sub`, `<chip>.pluck.arp`, `<chip>.brass.stab`, `<chip>.epiano.dx`, `<chip>.bell.dx`, `<chip>.kick.linn`, `<chip>.kick.808`, `<chip>.snare.gated`, `<chip>.snare.linn`, `<chip>.clap.linn`, `<chip>.hat.linn`, `<chip>.openhat.linn`, `<chip>.tom.linn`, `<chip>.crash.linn`.
The roles follow the id's middle part, and `epiano.dx` has role `arp` like `snes.arp.epiano`. Instrument names are unique within a chip (`saw-lead`, `supersaw`, `gated-snare`, ...).

### D1. Recipes and presets
Owned files: `src/core/synth/samplegen/bank.ts` (RECIPES), new `src/core/synth/samplegen/synth.ts` (generators), `presets/ps1.ts`, `presets/dreamcast.ts`, `tests/core/samplegen.test.ts`, new `tests/core/synthPresets.test.ts`.
- New recipe ids, with **no change to existing recipes**: `supersaw` (N = 3..9 band-limited saws with detune quantized to loop bins so the loop is seamless, ~8-16k-sample loop, `detune`, `voices`, `bright`), `sawlead` (2 detuned saws + optional octave, short loop), `syncsaw`, `junopad` (PWM-style detuned pulses with baked chorus, slow bloom intro), `analogbass` (saw + sub square, low-passed, `cutoff`, `pluck` one-shot or loop), `fmbass` (2-op DX bass via `fmTone`), `synthpluck` (saw through a decaying low-pass, one-shot), `synthbrass` (saw stack with a baked filter swell intro and then a loop), `dxepiano` and `dxbell` (`fmTone` variants with tine and bell ratios), `linnkick`, `808kick` (long sine boom, `decay`), `linnsnare`, `gatedsnare` (snare + deterministic baked reverb tail, hard gate at `gate` 0.15..0.4 s), `linnclap`, `linnhat` / `linnopenhat`, `linntom` (pitchable, base C-4), `linncrash`. Rates: a `RATE44` param (default 44100, max 48000) with `targetRate: 44100` for additive loops. Everything is seeded, so the same params give the same samples.
- Presets: PS1 uses ADSR plus `reverb: true` on pads, leads, snare and claps, and dry kick and bass. Dreamcast leans on its features: `brass.stab` and `bass.analog` use the filter envelope rather than a baked sweep, `lead.saw-detuned` gets LFO vibrato depth 1-2, pads use `send` 10-12 into `chorus-hall`, and the drums are `pcm16`. Each PS1 preset uses the `psx` target, so the 4-bit grit stays. Dreamcast drums are `pcm16` and pads may use `adpcm` to save RAM (stated in the description).
- Tests: each new recipe is deterministic and has the documented loop alignment and a peak in 0.5..0.95. Every contract id exists on both chips, resolves, validates, and is in tune at its base note and an octave up (the same check as `snes.test.ts` "pitched presets are in tune"). The gated snare's tail energy after the gate is < -40 dB. The default song RAM stays under budget when all synthwave presets are added at once (PS1 512 KB is the tight one; if it does not fit, shorten loops and record it).

### D2. Moods and composer
Owned files: `src/core/theory/moods.ts`, `progressions.ts`, `drums.ts`, `src/tools/composer.ts`, `tests/core/theory.test.ts`, `tests/tools/studio.test.ts` (new cases only), new `tests/tools/synthwave.test.ts`.
- Moods, **appended** to `SEEDS`:
  - `synthwave`: 96-118 BPM, keys A E D F# C, scales minor/dorian, lead `lead`, harmony `arp`, pad `pad`, bass `bass`; sections Intro 4, A 8, B 8, A 8, Bridge 4, loop from A.
  - `outrun`: 108-118, driving, minor/phrygian-light, rolling 16th bass.
  - `darkwave`: 88-112, minor/phrygian/harmonic-minor, colder, sparser arps, bass 8ths.
  - `dreamwave`: 80-100, dorian/minor with maj7 colour, slow pads, half-time drums, big chorus.
  Each has techniques text: "detuned saw lead an octave above the arp", "gated snare on 2 and 4", "sidechain feel: pads on the off-beat, v drops after the kick", "i-bVI-bIII-bVII", "keep the bass on straight eighths".
  Aliases: `retrowave`, `synth`, `80s` → synthwave; `chase`, `drive` → outrun; `coldwave`, `goth` → darkwave; `chillwave`, `dreamsynth` → dreamwave. Keep `dreamy` → ambient.
- Progressions: tag `epic-minor` (i-bVI-bIII-bVII) and `underwater-minor` with synth moods. Add new ones tagged only with synth moods: `synth-night` (i bVI bIII bVII, the canonical one; if it duplicates `epic-minor`'s numerals, just tag `epic-minor`), `synth-drive` (i bVII bVI bVII), `synth-rise` (bVI bVII i i), `dark-pulse` (i bII bVI bVII), `dream-float` (i7 bVImaj7 bIIImaj7 bVII).
- Drum styles, new and tagged only with synth moods, appended so they come first for these moods: `synthwave-gated` (kick 1 and 3 + "and of 2", gated snare 2 and 4, 8th hats, crash on bar 1), `outrun-four` (four on the floor, 16th hats, open hat off-beats), `darkwave-pulse`, `dreamwave-half` (half-time, toms in the fill). They use the `tom` lane in fills so the tom presets play.
- Composer, everything behind `SYNTH_MOODS.has(mood.id)`. No new draws from the main RNG for other moods; the new randomness uses `createRng(seed ^ 0x9e3779b9 ^ 0x5357)`.
  - `DEFAULT_CHIP`: synthwave → ps1, darkwave → ps1, outrun → dreamcast, dreamwave → dreamcast (decision 2).
  - `styleFor`: density medium (busy for outrun), chordBars 1 (2 for dreamwave), new bass patterns `drive` (8 straight root eighths, the octave on the last) and `roll` (16th roots with octave pops), drums from the new style, level 1.
  - `synthPresetRef(chip, part)`: on ps1 and dreamcast the contract ids (lead `lead.saw-detuned`, pads `pad.supersaw` + `pad.juno`, bass `bass.analog` (`bass.fm` for darkwave), arp `pluck.arp`, drums `kick.linn`/`snare.gated`/`hat.linn`/`tom.linn`/`crash.linn`; dreamwave uses `epiano.dx` as a second pad). Other chips use role presets (synthwave on NES still works).
  - Arrangement extras on chips with at least 12 voices: a 16th-note arpeggio of chord tones over 2 octaves on the arp channel (up or up-down pattern from the synth RNG); 3 pad voices (root, 3rd, 5th, plus the 7th when the chord has one) instead of 2; a lead double on V3 an octave down at lower volume with `G02` delay as a chorus-style double; brass stabs on V10 on the chord changes for outrun.
  - Chip FX: ps1 reverb `hall` (dreamwave `space-echo`, darkwave `studio-large`); dreamcast DSP `chorus-hall` (outrun `chorus-delay`, delay = dotted 8th from bpm).
- Tests (`synthwave.test.ts`): for every synth mood, the same seed gives the same song (`serializeProject` equal), a different seed gives a different song, the BPM is in range, the scale is minor-family, the progression comes from the mood list, the default chip is right, there are no validation errors, it is audible on ps1 and dreamcast **and** on every other chip, the bass channel has 8 notes per bar for synthwave, the arp channel has 16 per bar on ps1, and drums use the gated snare preset. `get_mood_recipe` returns the new moods with plans for all 7 chips. **`composerPin.test.ts` unchanged and green.**

**Done when** typecheck, lint and test pass, and smoke renders of `compose_track {mood:"synthwave", seed:1}` on ps1 and `{mood:"outrun", seed:1}` on dreamcast sound like synthwave (listen to the files; peak about -1..-6 dBFS, no clipping-limiter pumping).
Commits: `MDI-10: Synthwave recipes and presets for PS1 and Dreamcast` (D1), `MDI-10: Synthwave, outrun, darkwave and dreamwave moods in compose_track` (D2).

---

## Phase E2: MCP tools, docs, MIDI, roadmap (after D)

Owned files: `src/tools/defs/*`, `src/tools/util.ts`, `src/core/codecs/midi.ts`, `docs/llm-guide.md`, `src/tools/guideText.ts` (generated), `README.md`, `ROADMAP.md`, `tests/tools/*` (new cases), `tests/core/midi.test.ts`.

- Tool texts: `new_song` (chip list, `chipConfig` examples `{"voices":24}`, `{"reverb":{"preset":"hall"}}`, `{"dsp":{"preset":"chorus-hall"}}`), `set_song_info` (reverb/dsp merge), `compose_track` (chips, synth moods and their defaults, instrument override example `{"V2":"ps1.lead.sync"}`), `compose_sfx` (chip list), `convert_chip` (the mapping text gains V1/V2 for the new chips), `add_instrument` kinds doc (the two new kinds with short field lists). `list_chips` is generic; check its output. The guide test compares the tool list.
- `list_samples` / `generate_sample`: RAM blocks for ps1 (SPU RAM) and dreamcast (AICA RAM), and the right `add_instrument` hint per chip (`psx-sample` with adsr and reverb; `aica-sample` with format, aeg and send). `generate_sample` lists the new recipes.
- **MIDI export with more than 15 melodic channels**: `allocMelodic` now pins every channel past the 15th to MIDI channel 15, so program changes and pitch bends collide. Share MIDI channels by GM program first, and when the free channels run out, merge onto the channel with the same program, then the least-used one. Note it in the report. Test it with a 24-voice PS1 song. Existing exports (≤15 melodic) must stay byte-identical (`midi.test.ts`).
- `import_midi`: works for both chips via slots. Add a test that a GM file with 10 melodic tracks keeps more of them on ps1 than on snes.
- Docs (`docs/llm-guide.md`): intro and chip list; new `### PlayStation (SPU)` and `### Dreamcast (AICA)` sections (channels, voices config, instrument kinds and fields with examples, ADSR/AEG cheat sheets with times, reverb/DSP presets and what they sound like, RAM budgets, pmod/noise/LFO/filter idioms, synthwave layout V1..V16); the moods table rows; `E` effect row; `compose_track` paragraph. **Short section**: add "PS1 (V1-V16/24 samples + reverb), Dreamcast (V1-V16..64 samples + DSP)" and shorten other lines to stay ≤1500 chars. Then run `yarn gen:guide`.
- README: chip list in the intro and the `compose_track` table row (synth moods). ROADMAP: an MDI-10 paragraph in the same style as MDI-07..09 (what landed, the approximations: PS1 reverb resampling, AICA DSP presets and no microcode, the voices default) and any follow-ups.
- Tests: `tests/tools/song.test.ts` (new_song for both chips with voices/reverb/dsp; set_song_info merge; `voices` refused in set_song_info), `tests/tools/samples.test.ts` (hints, RAM lines), `tests/tools/studio.test.ts` (compose_track synthwave via the tool host with `render_audio` to `.claude/temp`), `tests/tools/guide.test.ts`.

**Done when** typecheck, lint and test pass, `yarn gen:guide` is clean (no diff after running it again), `yarn build` passes, and the live smoke test below passes.
Commit: `MDI-10: Tools, MIDI channel sharing, guide, README and roadmap for PS1 and Dreamcast`.

---

## Verification

Per slice:
```
yarn typecheck && yarn lint
yarn test
yarn vitest run tests/core/synth/snes.test.ts tests/tools/composerPin.test.ts   # quick regression guard (every slice)
```
Phase A also: `npx tsx .claude/temp/mdi10/snes-baseline.ts --check` (compares against `snes-baseline.json`).

Render smoke (from B on): `.claude/temp/mdi10/smoke.ts` (`npx tsx`) builds a hand-written song per new chip (and from D on `composeSong({mood:'synthwave', chip:'ps1', seed:1})`, `{mood:'outrun', chip:'dreamcast', seed:1}`, `{mood:'darkwave', seed:2}`, `{mood:'dreamwave', seed:3}`). It renders with `renderSong`, writes WAVs with `writeWav` to `.claude/temp/mdi10/`, and prints duration, peak, RMS, the loop points and the render time per second of audio.

Live MCP smoke (E2, as in MDI-05; client `.claude/temp/mdi10/mcp-smoke.mjs` with the MCP SDK Streamable HTTP client):
```
yarn build
yarn mcp            # logs MCP listening on http://127.0.0.1:7458/mcp
```
Then:
- `tools/list` (count unchanged plus any new tools; none are planned);
- `list_chips {chip:"ps1"}`;
- `new_song {chip:"dreamcast", chipConfig:{voices:32}}`;
- `compose_track {mood:"synthwave", seed:1}` → chip ps1;
- `render_audio {path:"<abs>/.claude/temp/mdi10/synthwave.ogg"}`;
- `compose_track {mood:"outrun", chip:"dreamcast", seed:1, intro:2}` + `render_audio` (`loopStartSec` ≈ 2 bars);
- `convert_chip {chip:"snes"}` + `render_audio`;
- `compose_sfx {kind:"stinger", sound:"success", chip:"ps1", path:...}`.
ffprobe durations must match the reported ones. Stop the server afterwards. Use forward slashes in paths (MDI-05 note).

Final: `yarn build`, `yarn test` (all), and a manual listen of the smoke files by the user (we cannot hear them; RMS and peak checks only catch silence and clipping).

## Risks

1. **SNES bit-exactness in the refactor.** Moving code into a base class can change float operation order or add per-sample virtual dispatch. Mitigations: verbatim moves, the A0 baseline of every SNES preset and composer song, the golden hash, block parity tests, and a perf comparison (≤ +15%).
2. **Voice count vs. the tracker channel model.** One channel = one monophonic voice, so 24 and 64 voices mean 24 and 64 channels. That inflates `get_song` and `read_pattern` (all channels by default), `set_orders` per-channel arrays, the tracker width, `.ctune` order rows and LLM token use. MIDI has 16 channels (handled in E2). Mitigation: `voices` defaults to 16 with role layouts in V1..V16. Check that `read_pattern` without `channels` on 64 voices still fits the tool output limits; if not, default it to channels with notes.
3. **CPU cost of 64 voices** in the 128-frame AudioWorklet: per-voice filter, LFO and resampling, plus the reverb and DSP. Mitigations: inactive-voice fast path, filter skipped when absent, the perf test in C, and a look at `audioEngine` underruns in `yarn dev` with a dense 64-voice song. A fallback if needed is a pass-through resampler when the output rate equals 44100. That changes no existing chip but must be decided before the goldens are recorded.
4. **Reverb accuracy vs. sound.** The PS1 reverb is approximated: its resampling FIR, the saturation points, and the 22.05 kHz rate (which keeps the lo-fi metallic character, wanted). The AICA DSP is not emulated at all, only modelled. Label both as approximations in the docs and the ROADMAP; the psx-spx preset values give the right character.
5. **Licensing.** Register tables come from documentation as data; no emulator source is copied; every sample is generated (no LinnDrum, 808 or DX ROM samples). The preset names describe a style ("LinnDrum-style", "DX-style"); trademarks are not used in the ids beyond `linn`/`dx` shorthand. The psx-spx reverb register values are used as data (decision 3).
6. **Long sample loops.** Supersaw and pad loops of 8-16k samples at 44.1 kHz cost generation time and cache memory. `syncSong` warms the cache in the voice constructor, which in the worklet runs on the audio thread, so there can be a glitch at song load. Mitigation: warm the cache on the main thread before posting the song (check `audioService.ts` and the renderer worker), keep loops ≤16k samples, and measure the generation time in D1's tests.
7. **The 1500-char short guide** has 1 char left; E2 must trim other lines.
8. **CHIP_IDS loops** make B0 data complete for every role, mood plan and preset lookup, and audio becomes testable only after B and C. Phase J exists for the leftovers.
9. **Composer determinism for existing moods** (pin test): any shared helper touched for synth moods (pads > 2, arp16) must branch before drawing from the RNG.
10. **convert_chip from 24/64 voices to 4-channel chips** drops many parts; the report must stay readable (summarize drops beyond 10).

## Open questions

None are blocking. Decisions 5-7 (Dreamcast effect presets, role-preset conversion, `V1..Vn` names) are director defaults that the user may still change before Phase C (5), Phase J (6) or Phase B0 (7) starts.
