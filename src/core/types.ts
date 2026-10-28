// Shared music-domain types (the Phase 2 contract between the core model/codecs and the synth).
// Pure TypeScript: no DOM, no Electron, no node:* APIs. Types only — helpers live in model.ts,
// notes.ts, chips/* and instruments/*.
//
// Conventions
//  - Pitches are MIDI note numbers: C-4 = 60, A-4 = 69 = 440 Hz. Tracker text "C-4" is MIDI 60.
//  - The song is tracker-native: every channel has its own pool of numbered patterns, and the order
//    list picks one pattern number per channel for each order row. All patterns are
//    `song.patternLength` rows long (a Dxx effect can end a row early).
//  - A note sounds from its row until the next note, note-off ('off') or release ('rel') on that channel.

export type ChipId = 'nes' | 'gb' | 'genesis' | 'snes' | 'pce' | 'ps1' | 'dreamcast'
export const CHIP_IDS: readonly ChipId[] = ['nes', 'gb', 'genesis', 'snes', 'pce', 'ps1', 'dreamcast']

export type PitchClass = 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B'

/** MIDI note number 0..127, 'off' = hard note-off (===), 'rel' = release / key-off (^^^, envelopes release). */
export type NoteValue = number | 'off' | 'rel'

/**
 * Effect codes (FamiTracker/Furnace style; parameter is one byte 0..255, written as two hex digits).
 *  '0' xy arpeggio            '1' xx slide up (xx/16 semitone per tick)   '2' xx slide down
 *  '3' xx portamento (00=off) '4' xy vibrato (x speed, y depth)           '7' xy tremolo
 *  'A' xy volume slide (x up, y down per tick)                            'B' xx jump to order xx
 *  'C' 00 halt song           'D' xx break to row xx of next order        'F' xx speed (<0x20) / BPM (>=0x20)
 *  'G' xx note delay (ticks)  'S' xx note cut after xx ticks              'P' xx fine pitch (80 = centre)
 *  'Q' xy note slide up (x speed, y semitones)                            'R' xy note slide down
 *  'W' xx timbre (pulse duty / wave index / noise mode / FM-unused)       'X' xx pan (00 left, 80 centre, FF right)
 *  'E' xx echo / effect send on (01) / off (00) for the channel: SNES echo, PS1 reverb, Dreamcast DSP
 */
export type EffectCode =
  | '0' | '1' | '2' | '3' | '4' | '7' | 'A' | 'B' | 'C' | 'D' | 'F' | 'G' | 'S' | 'P' | 'Q' | 'R' | 'W' | 'X' | 'E'
export const EFFECT_CODES: readonly EffectCode[] = [
  '0', '1', '2', '3', '4', '7', 'A', 'B', 'C', 'D', 'F', 'G', 'S', 'P', 'Q', 'R', 'W', 'X', 'E'
]

export interface Effect {
  code: EffectCode
  /** 0..255 */
  param: number
}

export interface Cell {
  note?: NoteValue
  /** Index into song.instruments. */
  inst?: number
  /** 0..15 on every chip (each chip maps it to its own volume range). */
  vol?: number
  fx?: Effect[]
}

export interface Pattern {
  /** Always song.patternLength entries; null = empty row. */
  rows: (Cell | null)[]
}

/** Key into song.patterns: `${channelId}:${patternNumber}`. */
export type PatternKey = `${string}:${number}`

export type ChannelKind =
  | 'pulse' | 'triangle' | 'noise' | 'dpcm' | 'wave' | 'fm' | 'psg-square' | 'psg-noise' | 'sample' | 'pce-wave'

export interface ChannelState {
  /** Fixed by the chip profile, e.g. 'P1', 'TR', 'NO', 'F1', 'S1', 'V3', 'C5'. */
  id: string
  name: string
  kind: ChannelKind
  /** Effect columns shown in the tracker. */
  fxColumns: 1 | 2 | 3 | 4
  muted?: boolean
  /** -1 (left) .. 1 (right); default 0. Chips quantize this (hard pan, 4-bit, ...). */
  pan?: number
  /** Mix trim in dB; default 0. */
  trim?: number
}

export interface Timing {
  bpm: number
  /** Ticks per row; default 6. */
  speed: number
  /** Rows per beat; default 4. */
  rowsPerBeat: number
  /** Beats per bar; default 4. */
  beatsPerBar: number
  /** Alternating speeds per row (e.g. [7,5] = swing). Overrides `speed` when present. */
  groove?: number[]
}

export type ScaleId = string

export interface SongMeta {
  key: PitchClass
  scale: ScaleId
  moods: string[]
  tags: string[]
  notes?: string
}

export interface NesConfig {
  chip: 'nes'
  region: 'ntsc' | 'pal'
  /** Adds the DM (DPCM) channel. */
  dpcm: boolean
  mixModel: 'nonlinear' | 'linear'
}
export interface GbConfig {
  chip: 'gb'
}
export interface GenesisConfig {
  chip: 'genesis'
  region: 'ntsc' | 'pal'
  /** F6 becomes a DAC sample channel. */
  fm6Dac: boolean
  /** Global FM LFO: 0 = off, 1..8 = YM2612 LFO rates. */
  lfo: number
}
export interface SnesEcho {
  /** 0..15 (x16 ms). */
  delay: number
  /** -1..1 */
  feedback: number
  volL: number
  volR: number
  /** 8 FIR coefficients, -1..1. */
  fir: number[]
}
export interface SnesConfig {
  chip: 'snes'
  echo: SnesEcho
}
export interface PceConfig {
  chip: 'pce'
}
/** PS1 SPU reverb presets (the psx-spx register-set names). */
export const PS1_REVERB_PRESETS = ['off', 'room', 'studio-small', 'studio-medium', 'studio-large', 'hall', 'half-echo', 'space-echo', 'echo', 'delay'] as const
export type Ps1ReverbPreset = (typeof PS1_REVERB_PRESETS)[number]
/** Voices a PS1 song can have (hardware maximum = the largest). */
export const PS1_VOICE_COUNTS = [16, 24] as const
export interface Ps1Reverb {
  preset: Ps1ReverbPreset
  /** 0..1, the reverb output volume (vLOUT/vROUT). */
  depth: number
  /** 0..1, the reverb input volume (vLIN/vRIN). */
  inputVol: number
}
export interface Ps1Config {
  chip: 'ps1'
  /** 16 or 24; structural (new_song only). */
  voices: (typeof PS1_VOICE_COUNTS)[number]
  reverb: Ps1Reverb
}

/** Dreamcast AICA DSP effect presets (fixed models; the real microcode is not emulated). */
export const DC_DSP_PRESETS = ['off', 'room', 'hall', 'plate', 'chorus', 'chorus-hall', 'delay', 'echo', 'chorus-delay'] as const
export type DcDspPreset = (typeof DC_DSP_PRESETS)[number]
/** Voices (slots) a Dreamcast song can have (hardware maximum = the largest). */
export const DC_VOICE_COUNTS = [16, 32, 64] as const
export interface DcDsp {
  preset: DcDspPreset
  /** 0..1 wet level. */
  mix: number
  /** 0..1 reverb time / size. */
  time: number
  /** 0..0.95 delay feedback. */
  feedback: number
  /** 0..1 chorus LFO rate. */
  chorusRate: number
  /** 0..1 chorus depth. */
  chorusDepth: number
  /** 10..1000 ms delay time. */
  delayMs: number
}
export interface DreamcastConfig {
  chip: 'dreamcast'
  /** 16, 32 or 64; structural (new_song only). */
  voices: (typeof DC_VOICE_COUNTS)[number]
  dsp: DcDsp
}
export type ChipConfig = NesConfig | GbConfig | GenesisConfig | SnesConfig | PceConfig | Ps1Config | DreamcastConfig

// ---------------------------------------------------------------------------------------------
// Instruments

export type Role =
  | 'lead' | 'bass' | 'pad' | 'strings' | 'brass' | 'pluck' | 'bell' | 'organ' | 'arp' | 'flute' | 'choir'
  | 'kick' | 'snare' | 'hihat' | 'openhat' | 'crash' | 'tom' | 'clap' | 'sfx'
export const ROLES: readonly Role[] = [
  'lead', 'bass', 'pad', 'strings', 'brass', 'pluck', 'bell', 'organ', 'arp', 'flute', 'choir',
  'kick', 'snare', 'hihat', 'openhat', 'crash', 'tom', 'clap', 'sfx'
]

/** A FamiTracker-style per-tick sequence. */
export interface Macro {
  values: number[]
  /** Index the sequence loops back to after the end (while the note is held). */
  loop?: number
  /** Index where the sequence continues once the note is released ('rel'). */
  release?: number
  /** Arp macros only: 'rel' = semitone offsets from the note (default), 'fixed' = absolute MIDI notes. */
  mode?: 'rel' | 'fixed'
}
/** vol: 0..15 multiplier of the cell volume; arp: semitones; pitch: 1/16 semitone per tick (relative, accumulates); timbre: chip-specific (duty, wave index, noise mode). */
export type MacroName = 'vol' | 'arp' | 'pitch' | 'timbre'
export type Macros = Partial<Record<MacroName, Macro>>

export interface FmOp {
  /** Attack rate 0..31 */ ar: number
  /** Decay rate 0..31 */ dr: number
  /** Sustain (2nd decay) rate 0..31 */ sr: number
  /** Release rate 0..15 */ rr: number
  /** Sustain level 0..15 */ sl: number
  /** Total level (attenuation) 0..127 */ tl: number
  /** Key scale 0..3 */ ks: number
  /** Multiplier 0..15 (0 = x0.5) */ ml: number
  /** Detune -3..3 */ dt: number
  /** SSG-EG 0..15 (0 = off) */ ssg?: number
  /** Amplitude modulation enable */ am?: boolean
}

export interface InstrumentBase {
  name: string
  role?: Role
  presetId?: string
  /** Hints for MIDI export: GM program (0..127) or a drum note on channel 10. */
  gm?: { program?: number; drumNote?: number }
}

export type InstrumentKind =
  | 'nes-pulse' | 'nes-tri' | 'nes-noise' | 'psg' | 'psg-noise'
  | 'gb-pulse' | 'gb-wave' | 'gb-noise'
  | 'pce-wave' | 'fm' | 'snes-sample' | 'sample' | 'psx-sample' | 'aica-sample'

export interface MacroInstrument extends InstrumentBase {
  kind: 'nes-pulse' | 'nes-tri' | 'nes-noise' | 'psg' | 'psg-noise'
  macros: Macros
  /** psg-noise / nes-noise default mode. */
  noiseMode?: 'white' | 'periodic'
}
export interface GbEnvelope {
  /** Initial volume 0..15 */ init: number
  dir: 'up' | 'down'
  /** Envelope pace 0..7 (0 = constant). */ pace: number
}
export interface GbPulseInstrument extends InstrumentBase {
  kind: 'gb-pulse'
  env: GbEnvelope
  /** 0 = 12.5%, 1 = 25%, 2 = 50%, 3 = 75% */
  duty?: 0 | 1 | 2 | 3
  /** P1 only. */
  sweep?: { pace: number; dir: 'up' | 'down'; step: number }
  macros?: Macros
}
export interface GbNoiseInstrument extends InstrumentBase {
  kind: 'gb-noise'
  env: GbEnvelope
  /** 7-bit LFSR (metallic) when true. */
  short?: boolean
  macros?: Macros
}
export interface GbWaveInstrument extends InstrumentBase {
  kind: 'gb-wave'
  /** 32 samples, each 0..15. */
  wave: number[]
  /** 0 = mute, 1 = 100%, 2 = 50%, 3 = 25% (hardware order). */
  level: 0 | 1 | 2 | 3
  macros?: Macros
}
export interface PceWaveInstrument extends InstrumentBase {
  kind: 'pce-wave'
  /** One or more 32-sample waves, each 0..31; the timbre macro / Wxx picks the index. */
  waves: number[][]
  /** Noise mode (only allowed on C5/C6). */
  noise?: boolean
  macros: Macros
}
export interface FmInstrument extends InstrumentBase {
  kind: 'fm'
  /** Algorithm 0..7 */ alg: number
  /** OP1 feedback 0..7 */ fb: number
  /** AM sensitivity 0..3 */ ams: number
  /** PM (vibrato) sensitivity 0..7 */ pms: number
  /** OP1..OP4 in diagram order. */
  ops: [FmOp, FmOp, FmOp, FmOp]
  macros?: Macros
}
export type SnesEnvelope =
  | { adsr: [attack: number, decay: number, sustainLevel: number, sustainRate: number] }
  | { gain: { mode: 'direct' | 'linear-dec' | 'exp-dec' | 'linear-inc' | 'bent-inc'; rate: number } }
export interface SnesSampleInstrument extends InstrumentBase {
  kind: 'snes-sample'
  /** SampleSlot id. */
  sample: string
  /** MIDI note at which the sample plays at its native rate. */
  baseNote: number
  env: SnesEnvelope
  echo: boolean
  /** Fine tune in cents. */
  fine?: number
  macros?: Macros
}
/** PS1 SPU ADSR register values (psx-spx): rate fields count from 0 = fastest; sustainLevel 0..15 is (n+1)/16 of full level. */
export interface PsxAdsr {
  /** Attack rate 0..127 (shift = n>>2, step = n&3). */
  attack: number
  /** Exponential attack (slows above 0x6000) instead of linear. */
  attackExp: boolean
  /** Decay shift 0..15 (always exponential). */
  decay: number
  /** Sustain level 0..15. */
  sustainLevel: number
  /** Sustain rate 0..127. */
  sustainRate: number
  sustainDir: 'dec' | 'inc'
  sustainExp: boolean
  /** Release shift 0..31. */
  release: number
  releaseExp: boolean
}
/** PS1 SPU voice: a PS-X ADPCM sample with the hardware ADSR, optional pitch modulation and noise. */
export interface PsxSampleInstrument extends InstrumentBase {
  kind: 'psx-sample'
  /** SampleSlot id. */
  sample: string
  /** MIDI note at which the sample plays at its native rate. */
  baseNote: number
  /** Fine tune in cents. */
  fine?: number
  adsr: PsxAdsr
  /** Send to the SPU reverb (Exx on a cell overrides it). */
  reverb: boolean
  /** Pitch modulation by the previous voice's output (not on V1). */
  pmod?: boolean
  /** Replace the sample by the global noise generator (shift 0..15, step 0..3). */
  noise?: { shift: number; step: number }
  macros?: Macros
}

/** Dreamcast AICA amplitude envelope (rates 0..31, 31 = fastest) and decay level (0..31, 0 = no decay). */
export interface AicaAeg {
  ar: number
  d1r: number
  d2r: number
  rr: number
  dl: number
  /** Key rate scaling 0..15. */
  krs?: number
}
/** Dreamcast AICA per-slot resonant low-pass filter and its envelope. */
export interface AicaFilter {
  /** Resonance 0..31. */
  q: number
  /** Filter levels FLV0..FLV4, 0..8191 (8191 = open). */
  flv: [number, number, number, number, number]
  far: number
  fd1r: number
  fd2r: number
  frr: number
}
export type AicaLfoWave = 'saw' | 'square' | 'tri' | 'noise'
export interface AicaLfo {
  /** LFO frequency 0..31. */
  freq: number
  pitchWave: AicaLfoWave
  /** Pitch (vibrato) depth 0..7. */
  pitchDepth: number
  ampWave: AicaLfoWave
  /** Amplitude (tremolo) depth 0..7. */
  ampDepth: number
  /** Restart the LFO on every key-on. */
  reset: boolean
}
/** Dreamcast AICA slot: PCM16, PCM8 or 4-bit ADPCM sample with AEG, optional filter and LFO. */
export interface AicaSampleInstrument extends InstrumentBase {
  kind: 'aica-sample'
  /** SampleSlot id. */
  sample: string
  /** MIDI note at which the sample plays at its native rate. */
  baseNote: number
  /** Fine tune in cents. */
  fine?: number
  format: 'pcm16' | 'pcm8' | 'adpcm'
  aeg: AicaAeg
  filter?: AicaFilter
  lfo?: AicaLfo
  /** DSP send level 0..15 (Exx on a cell overrides it on/off). */
  send: number
  macros?: Macros
}

/** Raw sample playback: NES DPCM, Genesis F6 DAC, PCE DDA. */
export interface SampleInstrument extends InstrumentBase {
  kind: 'sample'
  sample: string
  baseNote?: number
  macros?: Macros
}

export type Instrument =
  | MacroInstrument
  | GbPulseInstrument
  | GbNoiseInstrument
  | GbWaveInstrument
  | PceWaveInstrument
  | FmInstrument
  | SnesSampleInstrument
  | SampleInstrument
  | PsxSampleInstrument
  | AicaSampleInstrument

/** A sample: either generated from a recipe (regenerated and cached on load) or user PCM. */
export interface SampleSlot {
  id: string
  name: string
  source:
    | { kind: 'recipe'; recipe: string; params: Record<string, number | string | boolean> }
    | { kind: 'pcm'; sampleRate: number; /** base64 little-endian PCM16 mono */ data: string }
  /** Loop start in samples (absent = one-shot). */
  loopStart?: number
}

export interface RefLink {
  assetId: string
  note?: string
}

export interface Song {
  format: 1
  id: string
  name: string
  chip: ChipId
  chipConfig: ChipConfig
  /** strict: chip violations are errors in write tools; relaxed: warnings. */
  authenticity: 'strict' | 'relaxed'
  meta: SongMeta
  timing: Timing
  /** 1..256 rows per pattern. */
  patternLength: number
  /** Fixed by the chip profile (and its config). */
  channels: ChannelState[]
  /** orders[orderRow][channelIndex] = pattern number. */
  orders: number[][]
  /** Sparse: a missing key means an empty pattern. */
  patterns: Map<PatternKey, Pattern>
  /** Index = instrument number (@n); max 64. */
  instruments: Instrument[]
  samples: SampleSlot[]
  /** Order row the song loops back to; null = one-shot (jingle). */
  loop: { order: number } | null
  references: RefLink[]
}
