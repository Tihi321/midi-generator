# Chiptune Studio: guide for LLM agents

You are driving Chiptune Studio, a chiptune/MIDI composer for 8-bit and 16-bit game music (NES, Game Boy, Genesis, SNES, PC Engine). You edit the song through tools. The user watches every edit live and can undo it. Each tool call is one undo step, and a whole agent turn is one undo step in total. You cannot hear the music: you check it with `analyze_song` and `render_preview` (a piano-roll image), and the user listens.

<!-- short:start -->
Chiptune Studio quick guide
- Chips: NES (P1 P2 pulse, TR triangle, NO noise), Game Boy (P1 P2 pulse, WV wave, NO), Genesis (F1-F6 FM, S1-S3 PSG, NO), SNES (V1-V8 samples + echo), PC Engine (C1-C6 wavetable). Songs are strict: chip limits come back as errors with the fix.
- Workflow: `get_song` -> `get_mood_recipe` -> `new_song` (chip, bpm, key, mood) -> `add_instrument` ({"preset":"lead"}: a role or preset id) -> drums (`write_drums`), bass, harmony/arpeggio, lead (`write_pattern`, `write_melody`) -> `set_orders` + `set_loop` -> `analyze_song` -> `render_preview` -> `export_wav`.
- Tracker text: "0 | E-5 @lead v12 | C-4 @arp 037 | A-2 @bass | C-4 @kick". Channels split by "|"; tokens in any order: note (C-4, C#4, Db4), === off, ^^^ release, @instrument, vNN (0-15), 3-char effect (047 arpeggio, 4A2 vibrato, W02 duty). One note per cell: a chord on one channel is an arpeggio (047).
- Melody: "@lead v12 E5:2 G5:2 r:2 {A4 C5 E5}:8" (:N = rows). Drums: {"legend":{"K":"kick","S":"snare","h":"hat"},"steps":"K.h.S.h.K.KhS.h.","repeat":4}.
- 16 rows = 1 bar; a pattern = 64 rows = 4 bars; at most 64 rows per write call. Each order row picks a pattern per channel: `set_orders` [0,1,2,1] builds intro/A/B/A; `set_loop` sets the loop start.
- Fast: `compose_track` {mood, chip, seed} makes a loop; `render_audio` {path} writes ogg + loop points.
- Check with `analyze_song` and `render_preview`; `undo` fixes mistakes. Errors are text: correct the call. With References: `get_style_context`.
<!-- short:end -->

## Workflow for a new track

1. `get_song` to see what exists. The user may already have a song open: do not call `new_song` (it replaces the song; undoable) unless they asked for a new one.
2. `get_mood_recipe` with the mood ("heroic", "spooky", "chill", ...) and the chip: BPM range, key, scales, progressions, drum styles, arrangement (sections and bars) and the techniques that make the mood. `suggest_progression` realises chords in your key (with the arpeggio effect for each triad), `get_scale` lists the notes of the scale, `get_drum_pattern` gives ready-made `write_drums` arguments.
3. `new_song`, for example `{"chip":"nes","name":"Hero Theme","bpm":132,"key":"A","scale":"minor"}`. With `mood` it takes BPM, key, scale, groove and moods from the recipe. The channels come from the chip.
4. `add_instrument` for each voice. A preset id (`nes.lead.duty25`) or a ROLE (`lead`, `bass`, `arp`, `pad`, `pluck`, `bell`, `kick`, `snare`, `hihat`, ...); pass `channel` so a role picks the preset that plays there (bass on TR vs P1). `list_presets` shows the bank. Instruments are numbered `@0`, `@1`, ... and named (`@lead`). `write_drums` adds drum instruments by itself.
5. Write the parts, in this order: drums, bass, harmony/arpeggios, lead. Use `write_drums`, `write_pattern` (several channels at once) and `write_melody` (one channel). Write one section (one order row = one 64-row pattern per channel), then copy and vary it.
6. Build the structure with `set_orders` and `set_loop` (see Structure).
7. `analyze_song`: key check, chords per bar, clashes, notes out of scale, every chip-rule violation. Fix what it reports.
8. `render_preview`: look at the piano roll for rhythm, range and structure. Fix, preview again.
9. `export_wav` when asked (or `export_midi`, `save_project`; `convert_chip` / `import_midi` move music between chips, see MIDI). Tell the user the written paths.

### A complete NES example (A minor, 4 bars, loops)

```
new_song          {"chip":"nes","name":"Hero Theme","bpm":132,"key":"A","scale":"minor"}
add_instrument    {"preset":"lead","channel":"P1"}      -> @lead
add_instrument    {"preset":"arp","channel":"P2"}       -> @arp
add_instrument    {"preset":"bass","channel":"TR"}      -> @bass
write_drums       {"legend":{"K":"kick","S":"snare","h":"hat"},"steps":"K.h.S.h.K.KhS.h.","repeat":4}
write_pattern     {"text":"channels: TR | P2\n 0 | A-2 @bass | A-3 @arp 037\n 8 | E-3 | .\n16 | F-2 | F-3 047\n24 | C-3 | .\n32 | C-3 | C-4 047\n40 | G-2 | .\n48 | G-2 | G-3 047\n56 | D-3 | ."}
write_melody      {"channel":"P1","melody":"@lead v12 A5:4 C6:2 B5:2 A5:8 F5:4 A5:2 G5:2 F5:4 C5:4 E5:4 G5:2 E5:2 C5:4 G4:4 D5:4 G5:2 B5:2 G5:8"}
analyze_song      {}
render_preview    {}
export_wav        {"path":"hero-theme","stems":true}
```

## Song model and addressing

- A song has a chip, timing, a key and scale (metadata used by analysis and diatonic transpose), instruments and patterns. Channels are fixed by the chip (NES: `P1 P2 TR NO`). `get_song` lists them.
- Each channel has its own pool of numbered patterns of `patternLength` rows (default 64). The ORDER LIST has one row per section of the song; an order row names one pattern number per channel. The song starts with one order row `[0,0,0,0]`.
- Tools take `order` (default: the cursor's order row, usually 0) and channels by id (`"P1"`), name or 0-based index. Instruments are referenced by `@name` or `@index`.
- Timing: `bpm` is beats per minute, a row is a sixteenth note by default (`rowsPerBeat` 4), so 16 rows = 1 bar of 4/4, 64 rows = 4 bars. `speed` (ticks per row, default 6) only sets the resolution of effects. `groove` (e.g. `[7,5]`) makes swing.
- A note sounds from its row until the next note, `===` (note off) or `^^^` (release) on that channel. A channel plays ONE note at a time.
- Lookups accept ids, names or indices; when one fails the error lists the valid values.

## Tracker text (`write_pattern`, `read_pattern`)

```
channels: P1 | P2 | TR | NO
 0 | E-5 @lead v12 | C-4 @arp 037 | A-2 @bass | C-4 @kick
 4 | G-5           | .            | .         | C-4 @snare
 6 | A-5 4A2       | ===          | A-3       | C-4 @hat v6
```

- One line per row; the optional first number is the row (0-based; without numbers rows count 0,1,2...). Cells are separated by `|`. A `channels:` line names the columns (default: all channels in order). Lines starting with `#` are comments.
- A cell holds tokens in ANY order, recognised by their shape: note (`C-4`, `C#4`, `Db4`; C-4 is middle C = MIDI 60), `===` note off, `^^^` release, `@lead` or `@3` instrument, `v12` volume 0-15, a three-character effect (`047`, `4A2`, `W02`), `.` empty. Write hex digits in uppercase: `Db4` is D-flat, `DB4` would be the break effect D with parameter B4.
- Instrument and volume stay in effect on that channel until changed, so give `@inst` on the first note only.
- `mode: "merge"` (default) only touches the cells you list. `mode: "replace"` first clears the listed channels' patterns. Use `pattern: N` instead of `order` to write to a pattern number directly.
- Errors list every problem with the line, channel and fix (at most 12), and nothing is written.
- Up to 64 rows per call. For single cells use `set_cells`.

## Melody strings (`write_melody`)

`"@lead v12 E5:2 G5:2 A5:4 r:2 G5 F#5 E5:4 ~:4 {A4 C5 E5}:8 D5:4!4A2"` writes ONE channel; lengths are in rows.

- `E5`, `F#5`, `Db4` notes (octave 0-9; `C-4` style also works). `:N` length in rows (default 1, or `defaultLength`).
- `r` or `===` rest (note off), `^^^` release, `~:N` tie (hold the previous note N more rows).
- `@lead` and `vN` set instrument and volume for the notes that follow.
- `{A4 C5 E5}:8` a chord: on a one-voice channel it becomes the lowest note plus an arpeggio effect `0xy` (intervals up to 15 semitones; at most 3 distinct notes fit).
- `!4A2` puts effects on that note (`!4A2!W02` for two).
- It starts at `startRow` (default 0). If it is longer than the pattern use `wrap: true` (the next order rows must exist) or write the sections separately. `clear: true` empties the channel's pattern first.
- 16 rows = a bar: `E5:4` is a quarter note, `E5:2` an eighth, `E5:16` a whole note.

## Drum steps (`write_drums`)

```json
{"channel":"NO","legend":{"K":"@kick","S":"@snare","h":"hat v6"},"steps":"K.h.S.h.K.KhS.h.","repeat":4}
```

- One character per row, `.` is a rest; spaces and `|` are ignored so you can group steps. `repeat` repeats the whole string (16 steps x 4 = one 64-row pattern). `rowsPerStep` stretches each step.
- Legend values: an instrument (`@kick`), or a ROLE (`kick`, `snare`, `hihat` or `hat`, `openhat`, `crash`, `tom`, `clap`): the chip's preset for that role is added to the song automatically and the result tells you. Add a note (`C-4`) or a volume (`v6`) after it. `off` writes a note-off.
- The default channel is the noise channel. The noise channel plays one hit per row: when kick and hat coincide pick one (priority crash > snare > kick > hat). `get_drum_pattern` returns grooves in exactly this form. NES kicks and toms can also be played on TR (`nes.kick.tri-drop`).
- Noise instruments pick the noise pitch with a fixed arp macro, so the written note (C-4 by default) does not change the drum sound.

## Effects

Written as a code plus two hex digits (parameter `xx` = 00-FF, or `xy` = two nibbles). Pitch/volume effects stay active on the following rows until the same effect is written with parameter `00`.

| Effect | Meaning |
|---|---|
| `0xy` | Arpeggio: cycles the note, +x, +y semitones once per tick. C-4 with `047` = C E G (a major chord on one channel); `037` = minor. `000` stops it. With speed 6 a chord cycles twice per row. |
| `1xx` / `2xx` | Slide up / down, xx/16 semitone per tick. |
| `3xx` | Portamento: glide to the next note at xx/16 semitone per tick (needs a sounding note; `300` off). |
| `4xy` | Vibrato: x speed (1-F), y depth in 1/16 semitone (4A2 = speed A, depth 2). Restarts on each note. |
| `7xy` | Tremolo (volume wobble), same x/y. |
| `Axy` | Volume slide: x up, y down, (x-y)/4 volume steps per tick. |
| `Qxy` / `Rxy` | Note slide up / down by y semitones at speed x. |
| `Pxx` | Fine pitch (80 = centre). |
| `Gxx` | Delay the note by xx ticks (less than the row's ticks). |
| `Sxx` | Cut the note after xx ticks. `S03` = staccato at speed 6. |
| `Wxx` | Timbre: pulse duty 00-03 (12.5/25/50/75%), noise `W01` = short metallic mode, wave index on wave chips. |
| `Xxx` | Pan 00 left, 80 centre, FF right (chips quantize it; not on NES). |
| `Exx` | SNES echo on (01) / off (00) for the channel. |
| `Bxx` / `Dxx` / `C00` | Jump to order xx / break to row xx of the next order / stop the song. |
| `Fxx` | Speed (below 20) or BPM (20 and above), e.g. `F06`, `F90` (BPM 144). |

Each channel allows only some effects and a limited number of effect columns (`update_channel` `fxColumns`); strict songs reject others with the list of allowed ones.

## Chips

### NES (2A03), mono

| Channel | Range | Notes |
|---|---|---|
| `P1`, `P2` pulse | A-1 .. C-8 | 4 duties (`W00`-`W03` or the instrument's timbre macro), 16 volume levels. Lead on P1, counter-melody or arpeggiated chords on P2. |
| `TR` triangle | A-0 .. C-7 | Fixed volume: NO `v` values (they are errors in strict songs); stop notes with `===`. Bass: A-1 to A-3 sounds best. |
| `NO` noise | any | 16 noise periods chosen by the instrument (drums); `W01` = metallic short mode. One hit at a time. |
| `DM` DPCM | | Only with `chipConfig {"dpcm":true}` in `new_song`: sample drums (see the DPCM bullet below). |

- Typical layout: P1 lead, P2 arpeggio/harmony (`0xy`) or counter-melody, TR bass, NO drums.
- Chords on a pulse channel are arpeggios: one triad per row cycle. Fast arpeggios (`047` every row, speed 6) sound like chords; a held note over several bars needs the effect only on the first row.
- Bass: TR plays root notes and octaves. Use `nes.bass.tri` (default) or `nes.bass.tri-slap`.
- Echo trick: repeat the lead on P2 one row later with lower volume.
- Do not write a volume on TR; do not write notes below A-1 on pulse channels (strict errors tell you the fix).
- DM channel (DPCM, `new_song` `chipConfig {"dpcm":true}`): 1-bit delta samples, no volume. Use the `nes.dpcm.*` presets (kick, snare, hat, tom, crash, clap): `write_drums {"channel":"DM","legend":{"K":"kick","S":"snare"},...}` adds the sample with the instrument. The note picks one of 16 hardware playback rates like FamiTracker: C-4 is rate 12 (16.9 kHz) and each semitone down or up moves one rate step (C-3 is the slowest 4.2 kHz at the bottom; D#-4 the fastest 33 kHz). DPCM is loud and crunchy; keep it under the noise channel's hats and leave the DM channel for kick and snare.

### Game Boy (DMG), stereo with hard pan

| Channel | Range | Notes |
|---|---|---|
| `P1` pulse | C-2 .. C-8 | 4 duties, 16 volume levels, the only channel with a frequency sweep (`gb.lead.sweep`). |
| `P2` pulse | C-2 .. C-8 | Same without sweep. |
| `WV` wave | C-1 .. C-8 | 32 x 4-bit custom waveform and ONLY 4 volume levels: v15 (100%), v8 (50%), v4 (25%), v0 (mute); other values snap to the nearest. Bass or soft lead. |
| `NO` noise | any | 15-bit hiss (snare) or 7-bit metallic (`W01`, hats). |

- Typical layout: P1 lead, P2 harmony/arpeggio, WV bass, NO drums. WV bass presets: `gb.bass.wave-saw`, `gb.bass.wave-square`, `gb.bass.wave-tri`; custom waves via `add_instrument` `{"params":{"kind":"gb-wave","name":"b2","wave":"0123456789ABCDEFFEDCBA9876543210","level":1}}`.
- Pan with `X00` (left), `X80` (centre), `XFF` (right): hard pan only (00-55 left, 56-AA centre, AB-FF right).
- GB instruments have their own hardware envelope (`env` init/dir/pace) instead of volume macros for pulse and noise.

### Genesis (YM2612 FM + SN76489 PSG), stereo with hard pan

| Channel | Range | Notes |
|---|---|---|
| `F1`-`F6` FM | C-1 .. B-7 | 4-operator FM voice, one note at a time, 16 volume levels, hard pan `X00` left / `X80` centre / `XFF` right. Bass, lead, brass, strings, pads, e-piano, bells, plucks. |
| `F6` DAC | | With `new_song` `chipConfig {"fm6Dac":true}` F6 becomes a sample channel (drum samples) instead of an FM voice. Without it F6 is a normal FM channel and the FM drum presets play there. |
| `S1`-`S3` PSG square | A-2 .. C-8 | SN76489 square, mono (always centre), volume in 2 dB steps (16 levels). The lowest note is A-2 (110 Hz); anything lower is a strict error: move the line to FM. |
| `NO` PSG noise | any | White or periodic noise; the note picks the rate (below). One hit at a time. Hi-hats, snare fizz, crash. |

- Typical layout: F1 bass, F2 lead, F3 strings/pad (pan left), F4 second pad or e-piano (pan right), F5 brass stabs or arpeggio, F6 kick/snare (FM drums, or the DAC when enabled), S1 lead double an octave up, S2/S3 arpeggios or sparkle, NO hi-hats/snare noise.
- FM presets (add by id or role): bass `genesis.bass.slap` (default, algorithm 4 slap), `genesis.bass.synth`, `genesis.bass.finger`, `genesis.bass.sub`, `genesis.bass.growl`; lead `genesis.lead.saw` (default), `genesis.lead.square`, `genesis.lead.brass`; brass `genesis.brass.stab`, `genesis.brass.swell`; `genesis.strings.slow`, `genesis.pad.warm`, `genesis.choir.aah`; keys `genesis.epiano.tine`, `genesis.epiano.soft`, `genesis.organ.drawbar`; `genesis.bell.chime`, `genesis.pluck.guitar`, `genesis.flute.soft`, `genesis.arp.chip`; FM drums `genesis.kick.fm`, `genesis.snare.fm`, `genesis.tom.fm`, `genesis.hat.fm`, `genesis.crash.fm`.
- PSG presets: `genesis.lead.psg`, `genesis.arp.psg`, `genesis.lead.psg-echo`, `genesis.sfx.psg-zap`; noise `genesis.hihat.noise`, `genesis.openhat.noise`, `genesis.snare.noise`, `genesis.crash.noise`, `genesis.kick.noise`. A role resolves by channel: `add_instrument {"preset":"lead","channel":"S1"}` gives the PSG lead, on `F2` the FM saw lead; `write_drums` on `NO` adds the noise drum presets by role.
- Volume: the cell volume (`v0`-`v15`, times the `vol` macro) is added to the carriers' total level as attenuation: v15 = 0 dB, v8 = -5.5 dB, v4 = -11.5 dB, v0 = silent. FM instruments have their own envelopes (AR/DR/SR/RR/SL), so the `vol` macro is only for fades. `===` stops a note quickly; `^^^` (release) lets the operators' release rate ring out. Write `v` for dynamics (accents `v15`, soft layers `v8`-`v10`).
- FM idioms: slap bass on F1 with octave jumps (`E-2 E-2 E-3 E-2`); brass stabs on F5 (`genesis.brass.stab`, short notes on the offbeats); chords go on separate FM channels (root on F3, third/fifth on F4/F5) because one FM channel plays one note; string and choir pads (`genesis.strings.slow`) have a slow attack, so start the note a row early; double the lead on S1 an octave up at `v8`; vibrato with `4A2` on long lead notes.
- FM drums: the `*.fm` drum presets set their own pitch (a fixed `arp` macro), so write them at C-4 as `write_drums` does; `tom.fm` follows the written note (play fills from C-3 to C-4).
- PSG idioms: arpeggios (`037`, `047`) on S2/S3 at `v7`-`v9`; the lead double on S1; PSG volume steps are 2 dB so a decay macro sounds stepped. Noise drums: hat on C-4 every other row, snare on the backbeat. The PSG is much quieter than the FM channels, as on the real console (about 8 dB at equal volume).
- Noise rate follows the note: C-4 = fast (6991 Hz, bright), C#4 = medium (3496 Hz), D-4 = slow (1748 Hz, dull); from C-3 up the pattern repeats every 3 semitones (D#4 = fast, E-4 = medium, F-4 = slow ...). Notes below C-3 follow the pitch instead: with `W01` (periodic) the noise sounds as a tone at that note (thin kicks, toms), with white noise it is a rumble. The noise preset's `arp` macro (type `fixed`) sets this, so the written note rarely matters. `W00` = white, `W01` = periodic noise.
- Custom FM instrument: `{"params":{"kind":"fm","name":"my-bass","alg":4,"fb":5,"ams":0,"pms":0,"ops":[{"ar":31,"dr":16,"sr":10,"rr":8,"sl":6,"tl":32,"ks":0,"ml":1,"dt":0},{"ar":31,"dr":10,"sr":6,"rr":9,"sl":3,"tl":6,"ks":0,"ml":1,"dt":0},{"ar":31,"dr":22,"sr":12,"rr":8,"sl":4,"tl":40,"ks":0,"ml":4,"dt":0},{"ar":31,"dr":12,"sr":7,"rr":9,"sl":3,"tl":8,"ks":0,"ml":1,"dt":0}]}}`. Operators OP1..OP4: AR 0-31 (31 instant attack), DR/SR 0-31, RR 0-15, SL 0-15, TL 0-127 (127 = silent), KS 0-3, ML 0-15 (0 = half frequency), DT -3..3. Algorithm 0-7 decides which operators are carriers (alg 0-3: OP4 only; 4: OP2+OP4; 5/6: OP2+OP3+OP4; 7: all four); the others modulate, so a low TL on a modulator is a brighter sound and a low TL on a carrier is louder. `fb` 0-7 is OP1 feedback (more = buzzier). A carrier with a high ML and a slow decay is a bell. Check with `list_presets` before building one from scratch.
- F6 DAC drums (`new_song` `chipConfig {"fm6Dac":true}`): F6 plays 8-bit samples instead of FM. Use the `genesis.dac.*` presets (kick, snare, hat, openhat, crash, tom, clap): `write_drums {"channel":"F6","legend":{"K":"kick","S":"snare"},...}` adds each sample with its instrument. Write at C-4 (native rate); the note changes the playback rate (pitch), capped near 26 kHz. The DAC is mono per hit, cell volume `v0`-`v15` scales it, one sample at a time, and the F6 FM voice is gone while it is enabled.
- Global LFO: `chipConfig {"lfo":1..8}` (3.98 to 72 Hz; 0 = off, default) enables the instrument's `ams`/`pms` vibrato and tremolo (operators need `am:true` for AM).
- Pitch comes from the chip's 11-bit frequency number and 3-bit octave block (plus the operator multiplier and detune), and the PSG's 10-bit divider quantises its pitch (high PSG notes detune slightly): authentic.

### SNES (SPC700 samples), stereo with full pan and echo

| Channel | Range | Notes |
|---|---|---|
| `V1`-`V8` sample voices | C-0 .. B-8 | Every voice plays one BRR sample at a time (instrument kind `snes-sample`), v0-v15 volume and full pan `X00` left .. `X80` centre .. `XFF` right. Notes are relative to the sample's `baseNote`; the hardware pitch register tops out 4 octaves above it, so a note more than 24 semitones above the base note stops rising. |

- There are no synth waveforms: every sound is a sample. Presets bring their own sample: `add_instrument` adds the sample slot too (and `write_drums` with a role does the same). `list_samples` shows the slots, sizes and the 64 KB budget; `generate_sample {"recipe":"strings","params":{"bright":0.8},"name":"bright"}` makes a custom one, then `add_instrument {"params":{"kind":"snes-sample","name":"bright","sample":"bright","baseNote":60,"env":{"adsr":[9,5,6,0]},"echo":true}}`.
- Sample presets by role (add by id or role; pass `channel` to pick the voice): strings `snes.strings.ensemble` (default), `snes.strings.stac`; choir `snes.choir.aah`, `snes.choir.ooh`; `snes.organ.drawbar`; `snes.flute.breathy`; brass `snes.brass.section`, `snes.brass.stab`; pads `snes.pad.warm`, `snes.pad.glass`; plucks `snes.pluck.pizz`, `snes.pluck.harp`, `snes.pluck.guitar`, `snes.pluck.koto`; `snes.bell.glock`; `snes.arp.epiano`; bass `snes.bass.synth`, `snes.bass.pick`; leads `snes.lead.saw`, `snes.lead.square`; drums `snes.kick.drum`, `snes.snare.drum`, `snes.hat.closed`, `snes.openhat.open`, `snes.crash.cymbal`, `snes.tom.drum`, `snes.clap.hand`.
- Typical layout: V1 bass, V2/V3 pads or strings (pan left/right), V4 lead, V5 counter-line, V6 harp/pluck arpeggios, V7 kick/toms, V8 snare/hats/crash. Drums are one-shots: write them at C-4 (`write_drums` does); a tom plays other pitches (C-3 low, C-4 mid). One voice plays one sample at a time, so a snare and a hat share V8 and the later hit cuts the earlier one.
- Envelope (`env` of the instrument): ADSR `{"adsr":[attack 0-15, decay 0-7, sustainLevel 0-7, sustainRate 0-31]}` with the real SNES rate table: attack 15 is instant, 9 is about 64 ms, 6 is 0.25 s, 0 is 4 s; sustainLevel 7 means no decay stage; sustainRate 0 holds the level, 20 fades in about 0.2 s, 16 in about 0.5 s. GAIN `{"gain":{"mode":"direct"|"linear-dec"|"exp-dec"|"linear-inc"|"bent-inc","rate":0-31}}` ("direct" takes a level 0-127). A decaying GAIN mode starts at full level. `^^^` (release) fades out softly in about 0.1-0.3 s; `===` and `Sxx` cut in about 8 ms. Retriggering a sounding voice declicks first.
- Echo: the SNES's signature space. Each voice sends to one shared echo when its instrument has `echo: true`; `E01` turns the send on for that channel from that row on and `E00` off (overrides the instrument). The echo itself is song-wide: `set_song_info {"chipConfig":{"echo":{"delay":4,"feedback":0.4,"volL":0.3,"volR":0.3,"fir":[0,0,0,0,0,0,0,1]}}}` (fields merge; `delay` 0-15 in 16 ms steps, `feedback` -1..1, volumes 0-1, `fir` 8 taps -1..1 from oldest to newest). FIR examples: `[0,0,0,0,0,0,0,1]` no filtering, `[0.05,0.1,0.15,0.2,0.2,0.15,0.1,0.05]` low-pass (darker repeats), `[0,0,0,0,0,0,-0.5,1]` high-pass. Echo repeats are exported as their own stem `<name>_echo.wav` when `stems: true`.
- Memory: samples (about 9 bytes per 16 samples, listed by `list_samples`) plus the echo buffer (delay x 2 KB) must fit in 64 KB. A strict song reports "SNES ARAM budget exceeded" with the fix: lower the echo delay by a step, or drop the biggest sample (crash and harp are the largest presets, 5-8 KB each; a long echo delay of 8+ costs 16 KB).
- Idioms: strings or choir pads on two voices panned left and right with echo on; harp or koto arpeggios (`snes.pluck.harp`, one note per row) with echo on and a high feedback for the classic RPG sparkle; orchestral hits: `snes.brass.stab` + `snes.strings.stac` + `snes.kick.drum` on the same row; pizzicato bass (`snes.bass.pick`) against a held pad; flute melody over strings; bell or e-piano for towns and shops; dry bass and kick (`echo: false`) with wet snare, clap and leads.
- Authenticity: samples are generated (additive, Karplus-Strong and FM recipes) and run through a real BRR encode/decode, so they carry the 4-bit grit; playback uses the DSP's 4-point Gaussian interpolation at 32 kHz.

### PC Engine (HuC6280 wavetable), stereo with 4-bit pan

| Channel | Range | Notes |
|---|---|---|
| `C1`-`C4` wave | A-0 .. C-8 | 32 x 5-bit wave per instrument, 5-bit volume (v0-v15 cell volume x vol macro), pan per side. Bass, lead, harmony, arpeggio. |
| `C5`, `C6` wave or noise | A-0 .. C-8 | Like C1-C4, and the only channels where an instrument with `noise: true` makes noise (hats, snares, crash). Noise on C1-C4 is a strict error. |

- Typical layout: C1 bass, C2 lead, C3 chords/pad, C4 arpeggio or counter-line, C5 hats (noise), C6 snare (noise) or more melody. Kicks and toms are pitch-dropping waves (`pce.kick.drop`, `pce.tom.drop`) and work on any channel, so put the kick on C4 or C6.
- A wave instrument holds one or more waves (`waves`: a list of 32 integers 0-31 each; macros as in the other chips). The timbre macro or `Wxx` picks the wave index (`W00` = first, `W01` = second, ...; clamped to the last wave). A timbre macro that steps through waves is how pulse-width sweeps and evolving timbres are done: `pce.lead.pwm`. Wave 0 plays when nothing selects another.
- Wavetable leads sound best with vibrato: `4A2` or a `pitch` macro (`pce.lead.vibrato`). Sine bass (`pce.bass.sine`) under a saw or bright lead is the classic PC Engine sound; slow `vol` macros (`pce.pad.soft`, `pce.strings.wave`) give pads and strings; decaying `vol` macros give plucks and bells (`pce.pluck.wave`, `pce.bell.chime`).
- Noise instruments pick the noise pitch with a fixed `arp` macro (0-31, 31 = highest) and a decaying `vol` macro. The written note does not change the sound; write the drums with `write_drums` on `C5`/`C6` (legend roles `snare`, `hat`, `openhat`, `crash`, `clap` resolve to noise presets there; `kick` and `tom` are waves).
- Volume: cell volume `v0`-`v15` times the `vol` macro, quantised to the chip's 32 volume steps. Pan with `X00` (left) .. `X80` (centre) .. `XFF` (right): 16 steps per side, so mid-hard pans (`X30`, `XD0`) open up the mix.
- Custom instrument: `{"params":{"kind":"pce-wave","name":"w1","waves":[[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31]],"macros":{}}}`; add `"noise":true` (C5/C6 only) for noise.
- Pitch is quantised to the 12-bit frequency divider, so very high notes detune slightly (authentic).
- Presets: `pce.lead.saw`, `pce.lead.sine`, `pce.lead.square`, `pce.lead.bright`, `pce.lead.vibrato`, `pce.lead.pwm`, `pce.bass.saw`, `pce.bass.sine`, `pce.bass.square`, `pce.pad.soft`, `pce.strings.wave`, `pce.choir.wave`, `pce.organ.wave`, `pce.flute.sine`, `pce.brass.wave`, `pce.pluck.wave`, `pce.bell.chime`, `pce.arp.wave`, `pce.arp.pulse`, `pce.sfx.zap`, `pce.kick.drop`, `pce.tom.drop`, `pce.snare.noise`, `pce.hat.noise`, `pce.openhat.noise`, `pce.crash.noise`, `pce.clap.noise`.

## Instruments and presets

- `add_instrument` with `preset` (a preset id or a role). Presets per role on NES: lead (duty25/12/50/vibrato/pwm), flute, brass, pluck, arp, pad, organ, bell, sfx, bass (triangle or pulse), kick (noise or `tri-drop`), snare, hat, openhat, crash, clap, tom. Game Boy has the same roles plus wave-channel bass/pad/strings/organ. `list_presets` has descriptions and the channel kind each plays on.
- Give an instrument to a channel it can play: pulse instruments on P1/P2, triangle on TR, noise on NO (strict songs say which channels accept an instrument kind).
- Custom instruments: `params` with `kind` and fields (see the tool description). Macros are per-tick sequences, written as text: `"15 12 9 | 6 3 / 0"` (`|` = loop point, `/` = release point). `vol` is a 0-15 multiplier of the cell volume, `arp` is in semitones, `pitch` in 1/16 semitone per tick, `timbre` is the duty (pulse) or noise mode. Example: `{"kind":"nes-pulse","name":"zap","macros":{"vol":"15 12 9 6 3 0","timbre":"1","pitch":"-24 -20 -16 -12 -8 -4"}}`.
- `update_instrument` changes an instrument for every note that uses it; `delete_instrument` refuses while notes use it unless `force: true`; `get_instrument` prints one in full.
- Roles describe an instrument's job (lead, bass, pad, kick, ...); they also decide how drums are exported to MIDI later.

## Moods (`get_mood_recipe`)

| Mood | BPM | Typical keys | Scales | Feel |
|---|---|---|---|---|
| heroic | 112-140 | C D G F | major, mixolydian | bold leaps, dotted rhythm, driving bass |
| battle | 150-180 | A E D F# | minor, harmonic minor, minor pentatonic | fast, running bass, busy drums |
| boss | 140-175 | D E C# F# | phrygian, harmonic minor | heavy riff, chromatic pressure |
| spooky | 60-90 | A E C# G# | phrygian, locrian, whole-tone | sparse, bell lead, b2 and tritone |
| dungeon | 60-100 | D A F C | minor, phrygian, locrian | drones, short echoed motifs |
| chill | 70-100 | F C G D# | major, dorian, pentatonic, lydian | seventh chords, swing groove [7,5] |
| town | 100-125 | C G F D | major, pentatonic, mixolydian | bouncy oom-pah, call and response |
| overworld | 110-140 | C G D A | major, mixolydian, dorian | singable 2-bar theme, walking bass |
| victory | 120-160 | C F G A# | major | short fanfare, no loop |
| game-over | 50-80 | D A E C | minor, phrygian | slow descent, no loop |
| title | 80-120 | C D F A | major, lydian, minor | grand, one chord per bar |
| shop | 90-120 | F A# C D# | major, dorian | lounge, bossa drums |
| underwater | 60-90 | E B F# A | lydian, whole-tone | floating, slow arpeggios |
| desert | 90-120 | D E A G | phrygian dominant | b2 and raised 3rd, hand-drum groove |
| castle | 80-120 | D A E C | harmonic minor, dorian | stately, march drums |
| sad | 55-85 | A D E C | minor, dorian | long descending lines, soft or no drums |
| ambient | 60-76 | C D F A | lydian, pentatonic, dorian | very calm: slow pads, long soft notes, no drums |
| lullaby | 60-78 | F C G D | major, pentatonic | gentle rocking bass, simple tune, no drums |
| peaceful | 66-88 | G C D F | major, pentatonic, lydian | warm and unhurried, sparse melody, no drums |
| mysterious-calm | 60-80 | D A E C | dorian, melodic minor, lydian, whole-tone | quiet and curious, hovering chords, faint pulse |

The recipe also lists progressions, drum styles, the arrangement (sections with bars; 4 bars = one 64-row pattern) and per-channel parts for your chip.

## Structure: orders and loops

- One order row = one section of `patternLength` rows (4 bars by default). An 8-bar section is two order rows.
- `set_orders` takes a list: a number means the same pattern on all channels, an array gives one number per channel. `{"orders":[0,1,2,1],"loop":1}` = intro (pattern 0), A (pattern 1), B (pattern 2), A again (pattern 1 is reused: the same music, edits change both); the song loops back to order 1.
- A pattern number you have not written yet is an empty pattern. Write a section with `write_pattern` / `write_melody` / `write_drums` and `order: N`.
- To vary a repeat, `duplicate_order` (copies into new patterns), then edit it; `copy_pattern` copies one order row's music to another (optionally transposed: `semitones` or `degrees` in the key, e.g. `degrees: 2` = a third up); `transpose` shifts in place. `insert_order` / `delete_order` / `set_pattern_length` reshape the song.
- `set_loop` `{"order":N}` sets where the song loops back to (orders before it are the intro); `null` makes a one-shot jingle (victory, game over). An exported WAV carries the loop points.
- Typical track: intro 4 bars, A 8, B 8, A 8 (loop from A), 28-36 bars total, 1-2 minutes.

## Reading and checking

- `get_song`: structure and instruments. `read_pattern` returns tracker text (`format "tracker"`), a melody string (`"melody"`, one channel, `orders` for several order rows) or drum steps (`"drums"`), exactly in the write formats: read, change a few rows, write back.
- `analyze_song`: detected key vs declared key, chord per bar, harmonic clashes (minor seconds between channels), notes outside the scale, per-channel range and density, and every chip-rule violation. Aim for no chip issues; clashes are fine as passing notes.
- `render_preview`: piano-roll image. Bright vertical lines are order rows, medium lines bars. Colours per channel are listed in the reply. Arpeggio tones are dim bars. Drums are ticks in the bottom lanes. Use `fromOrder`/`toOrder` to zoom in. Look for: a melody that is too busy or too empty, notes crossing into other channels' ranges, missing drums, empty sections.
- Strict songs (default) reject writes that break the chip's limits and say how to fix them. If the user wants freedom, `set_song_info {"authenticity":"relaxed"}` turns these errors into warnings.

## Export

- `export_wav`: stereo 16-bit WAV, 44.1 kHz (or 48 kHz). A looping song is rendered intro + loop body and gets loop points in a `smpl` chunk (Godot, FMOD, Wwise read it); `loops` repeats the body (default 1); `fadeOutSec` makes a faded, non-looping file instead. `stems: true` also writes `<name>_<channelId>.wav` per channel with notes. Relative names go to `~/ChiptuneStudio/exports`. The result gives paths, length, peak level and loop points; a silent result means something is wrong (check instruments and muted channels).
- `render_audio` writes ONE audio file (ogg, mp3 or wav) for a game or app; see "Compose in one call and render audio" below.
- `save_project` writes a lossless `.ctune` file; `open_project` loads one (undoable).
- `play` / `stop` play the song in the editor for the user.
- `export_midi`, `import_midi` and `convert_chip` are described in the next section (the asset library after it).

## Compose in one call and render audio (for other apps)

Another app (for example VN Studio) can drive Chiptune Studio without a window: start it headless with `yarn mcp` (`electron . --mcp-only [--port N]`, default port 7458; needs `yarn build` first). Every tool then runs on a headless song, and the existing tools (`write_pattern`, `export_wav`, ...) act on the current song as usual. Playback (`play`) needs the window.

- `compose_track` composes a whole track in one call and makes it the current song: `{"mood":"ambient","chip":"snes","seed":1}`. Arguments: `mood` (all moods, including the calm `ambient`, `lullaby`, `peaceful`, `mysterious-calm`), optional `chip` (default per mood: SNES for calm moods, NES otherwise), `bpm`, `key`, `scale`, `bars` (default 16) or `seconds` (rounded to whole bars), `intro` (0..4 bars, default 0: a quiet pad and bass intro on the tonic, no lead or drums, played once before the loop; `bars` / `seconds` stay the loop body, the loop starts after the intro and `render_audio` reports it as `loopStartSec`), `motif` + `motifKey` (a leitmotif in the `write_melody` text format, notes / `r` / `~` only, at most 4 bars, e.g. "E5:4 G5:2 A5:2 B5:8"; it is transposed from `motifKey` (default C) to the track key and each out-of-scale note moves to the nearest scale note; it is the lead line of every even 4-bar phrase from the first loop bar, the repeats get a light variation (the last note or two fit the chord, every second repeat is moved a scale step), the other phrases stay generated; the result has `motif {bars,transposeSemis,placedAtBars}`), `variation` (0..99, default 0: the original; k > 0 keeps key, scale, tempo, chords, instruments and motif of the same seed and re-rolls the arrangement: lead rhythms and notes, bass pattern one step busier or calmer, pad voicing and entry, drum fill bars, the motif's development; use it to get the same theme for several scenes), `loop` (default true), `seed`, `instruments` ({"V4":"snes.flute.soft"}), `name`. The same seed and arguments give the same song; the seed used is returned. It writes a progression, bass, pads, a phrased melody and, for lively moods, drums. Calm moods use the soft presets (`snes.pad.soft-strings`, `snes.strings.swell`, `snes.pad.dream`, `snes.bell.soft`, `snes.flute.soft`, `snes.bass.soft`, `gb.pad.soft-square`, `gb.lead.soft-square`, `nes.lead.soft`, `nes.pad.soft-long`, `nes.bell.soft`), 60-90 BPM and no or very quiet drums. With `loop` the loop covers the whole song and ends exactly at the song end. Refine it afterwards with `write_pattern` / `write_melody`, or call it again with another seed.
- `render_audio` `{"path":"C:\music\theme.ogg"}` renders a song to one file: `format` ogg (default, ffmpeg libvorbis), mp3 or wav; `loops` (1..8), `fadeOutSec` (makes it non-looping), `sampleRate`, and `song` (an id from `list_songs`, default the current one). ffmpeg comes from `FFMPEG_PATH` or PATH; without it a WAV is written next to the path and `warning` says so. A looping song without a fade is rendered intro + loop body x loops, and the file ends exactly at the loop end: a player loops from `loopStartSec` to the end of the file (Ren'Py: `play music "<loop 3.2>theme.ogg"`). The WAV also carries the `smpl` loop chunk. Absolute paths are used as given (folders are created).
- `save_song` / `open_song` / `list_songs` / `delete_song` keep several songs per session. `compose_track` and `open_song` park the song they replace; `save_song {"path"}` writes the lossless `.ctune` file; `open_song {"path","exportTo","exportFormat"}` loads one and, with `exportTo`, exports the looping audio on every save. `delete_song` never deletes files.
- The new tools end their reply with one JSON text object: `compose_track` `{songId,name,chip,bpm,key,scale,mood,bars,introBars,variation,motif:{bars,transposeSemis,placedAtBars}|null,seed,durationSec,loop:{startBar,endBar}|null,channels}`, `render_audio` `{path,format,sampleRate,durationSec,loopStartSec,loopEndSec,loopStartSample,loopEndSample,warning?}`, `save_song` `{songId,path}`, `list_songs` `{songs:[{songId,name,path,chip,bpm,current}]}`, `open_song` `{songId,name,path}`, `delete_song` `{deleted:true}`.
- In the app window `--open <file.ctune> [--export-to <file>] [--export-format ogg|wav]` opens a song at launch (a second launch hands it to the running window); every save then also exports the audio to `--export-to` and writes `<exportTo>.json` next to it (`{loopStartSec, loopEndSec, durationSec, sampleRate}`, named after the file actually written).

## MIDI

- `export_midi` writes `<name>.mid` (SMF type 1, 480 PPQ) to `~/ChiptuneStudio/exports`. The timing is the song's: Bxx/Dxx/Fxx/groove become tempo changes so the MIDI plays at the speed of the audio. Track 0 holds tempo, time and key signature, an `order N` marker per order row and, for a looping song, `loopStart` / `loopEnd` markers plus CC111 at the loop start (RPG Maker convention); `loops` unrolls the loop body. Every channel with notes is a track with a GM program (from the instrument's role or `gm` hint); noise, DPCM, DAC and drum-role instruments go to MIDI channel 10 as GM drum notes (36 kick, 38 snare, 42 hat, 46 open hat, 49 crash, 45/48 toms, 39 clap). Volume is velocity (CC11 for changes under a held note); slides, portamento, vibrato and note slides become pitch bend (range +-12). `arpMode`: `"notes"` (default) writes 0xy as the fast notes the chip plays, `"chord"` as chords, `"ignore"` as the base note. Not exported: instrument macros, tremolo, duty/timbre, echo.
- `import_midi {"path":"boss.mid","chip":"genesis"}` replaces the song (ONE undo step) with a MIDI file converted for the chip (default: the open song's chip; bare names are looked up in exports, then projects; absolute paths work). Notes snap to a grid (`rowsPerBeat` 2/3/4/6/8, picked by least error unless forced); GM channel 10 becomes drums on the noise/drum channel(s) by drum note; melodic tracks are ranked (note count and pitch) into bass (TR / WV / F1 / V1 / C1), lead and harmony channels and reduced to ONE voice: the top voice, with up to two extra chord tones within 15 semitones folded into a 0xy arpeggio, the rest dropped. Notes move by octaves into the channel's range; velocities become `v` values; tempo changes become Fxx; `loopStart` / CC111 sets the loop; identical patterns are shared. The reply is a report of every assignment and drop: READ IT, then fix the song with the normal tools (`write_pattern`, `add_instrument`, `set_orders`). Options: `patternLength`, `maxChannels`, `foldChords`, `chipConfig`.
- `convert_chip {"chip":"nes"}` turns the open song into another chip (ONE undo step). Channels map by role: bass to TR / WV / F1 / V1 / C1, lead to P1 / F2 / V4 / C2, the rest to the other melodic channels, drums to the noise/drum channels (kick and toms split from the rest where the chip has two: SNES V7/V8, PCE C5/C6, Genesis F6 DAC + noise). What survives: notes (moved by octaves into range), tempo, orders, loop point, key, pattern length, volume (dropped on channels without volume), 0xy/slides/vibrato/portamento/flow effects, drum hits by role. What does not: macros and hand-made instruments (replaced by the target chip's preset for the same role; SNES sample slots are added), duty/timbre (`Wxx`) between different channel kinds, pan and echo on chips without them, and channels beyond what the target has (dropped, listed in the report; their Bxx/Cxx/Dxx/Fxx effects are moved to a kept channel). Fewer channels means dropped parts: Genesis (10) to NES (4) keeps bass, lead, one harmony and the drums. Read the report, then retune the new instruments.

## Library and style references

The library (`~/ChiptuneStudio/assets`) holds songs, motifs (a few channels of a section) and instruments the user saved, each with chip, key, tempo, moods, tags and style notes. The user may mark assets as STYLE REFERENCES for the song.

- If `get_song` lists References (or the system prompt has a style-context section), read `get_style_context` first: for each reference it gives the chip, tempo and groove, key and scale, moods, instruments (presets and parameters), drum step strings, the chord progression, a few rows of tracker text per main channel and the user's notes. Match the feel (groove, instrumentation, harmony, register, density); write new notes, do not copy the reference. The chip may differ: translate the idea (use `list_chips`).
- `list_assets` (filters: kind, chip, tags, mood, text) and `get_asset` (instruments, up to 32 tracker rows per main channel, preview image) browse the library. `set_style_reference` attaches or detaches assets on the song (one undo step).
- `place_asset` reuses a motif: it writes the notes at `order`/`row` (default the cursor), moves them from the motif's key to the song's key (chromatic by default; `diatonic: true` maps scale degrees onto the song's scale), adds the instruments the motif needs, and maps channels by id (same chip) or by role (other chip: the role's preset is used and you are told). `channels` picks the targets. An instrument asset adds that instrument (or its role's preset on another chip). A song asset cannot be placed: use `open_project` or follow its style.
- `save_as_asset` stores a `song`, a `motif` (`channels`, `fromOrder`/`toOrder`, `fromRow`/`toRow`) or an `instrument`, with `name`, `tags`, `moods` and `notes`; it only writes to the library. Deleting is a user action.

## Limits and good habits

- At most 64 rows per `write_pattern` call, 256 cells per `set_cells`, 64 instruments per song, 256 rows per pattern, 256 order rows.
- Work in layers (drums, bass, harmony, lead) and one section at a time, so each step can be undone on its own. Write a whole 4-bar pattern per call rather than row by row.
- If a call fails the song is unchanged: read the message, it says what to fix. Warnings (relaxed songs) are listed but the notes are written.
- Respect the channel limits: one note per channel (arpeggio effects for chords), TR has no volume, WV has 4 volume levels, pulse bass below A-1 does not exist.
- Keep melodies singable: repeat a motif with a changed ending, mostly stepwise with a few leaps, end phrases on chord tones, leave rests. Bass on the chord roots, drums on a steady grid.
- Do not paste the whole song back as text unless asked. Summarise what you wrote in a few sentences and name the file paths you exported.
