// Dreamcast preset bank. Phase B0 baseline: one preset per SNES preset (same recipe slots, so the same sounds), with the
// SNES envelope mapped to AICA AEG values by `snesToAicaAeg` and SNES echo becoming a DSP send. Ids are
// `dreamcast.<role>.<name>` (the SNES id with its prefix swapped). All baseline presets use pcm16. Phase D1 appends the
// synthwave presets of the preset-id contract (`DREAMCAST_SYNTH_PRESETS`), which lean on the AICA features: the filter
// envelope on the brass stab and the analog bass, LFO vibrato on the leads, pad sends into the chorus DSP, ADPCM pads to save
// RAM (a quarter of pcm16) and pcm16 drums.
//
// AICA AEG rates run 0..31 (0 = no change, 31 = fastest) and are doubled into the documented 6-bit rate tables (see
// synth/chips/aicaTables.ts): attack from silence to full takes 8.1 s at 6-bit rate 2 and a 96 dB decay or release
// takes 118.2 s, both halving every four 6-bit rates, i.e. every two register steps.

import type { AicaAeg, AicaFilter, AicaLfo, AicaSampleInstrument, Role, SampleSlot, SnesEnvelope, SnesSampleInstrument } from '../../types'
import { FLV_MAX, aicaAttackTime6, aicaFallTime6, aicaRate6 } from '../../synth/chips/aicaTables'
import type { Preset } from './types'
import { SNES_PRESETS } from './snes'
import { snesEnvTimes } from './snesTimes'

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)))

/** Seconds from silence to full level for an AEG attack rate 0..31 (the documented table; 31 is instant, 0 never). */
export function aicaAttackSeconds(rate: number): number {
  return rate <= 0 ? Infinity : aicaAttackTime6(aicaRate6(rate))
}
/** Seconds for a 96 dB fall at an AEG decay / release rate 0..31 (the documented table; 0 never). */
export function aicaFallSeconds(rate: number): number {
  return rate <= 0 ? Infinity : aicaFallTime6(aicaRate6(rate))
}

function nearestRate(target: number, seconds: (rate: number) => number): number {
  let best = 1
  let bestErr = Infinity
  for (let r = 1; r <= 30; r++) {
    const err = Math.abs(Math.log(seconds(r) / target))
    if (err < bestErr) {
      bestErr = err
      best = r
    }
  }
  return best
}

/** A SNES exponential time constant as an AICA fall rate (a linear-in-dB fall of the same slope near full level). */
function fallRate(tauSec: number): number {
  // exp(-t / tau) loses 8.686 / tau dB per second, so 96 dB take 11.05 * tau
  return nearestRate(11.05 * tauSec, aicaFallSeconds)
}

/** Approximate a SNES ADSR/GAIN envelope with AICA AEG values: same attack time, decay, sustain level and release. */
export function snesToAicaAeg(env: SnesEnvelope): AicaAeg {
  const t = snesEnvTimes(env)
  const levelDb = -20 * Math.log10(Math.max(t.sustainLevel, 1e-3))
  return {
    ar: t.attackSec <= 0.001 ? 31 : Number.isFinite(t.attackSec) ? nearestRate(t.attackSec, aicaAttackSeconds) : 1,
    d1r: fallRate(t.decayTauSec),
    // D2R 0 holds the level
    d2r: t.sustainTauSec === null ? 0 : fallRate(t.sustainTauSec),
    rr: fallRate(t.releaseTauSec),
    // DL is the attenuation where D1R hands over to D2R, in 3 dB steps (0 = full level)
    dl: clampInt(levelDb / 3, 0, 31)
  }
}

function fromSnes(p: Preset): Preset {
  const s = p.instrument as SnesSampleInstrument
  const instrument: AicaSampleInstrument = {
    kind: 'aica-sample',
    name: s.name,
    sample: s.sample,
    baseNote: s.baseNote,
    format: 'pcm16',
    aeg: snesToAicaAeg(s.env),
    send: s.echo ? 10 : 0
  }
  return {
    id: p.id.replace(/^snes\./, 'dreamcast.'),
    name: p.name,
    role: p.role,
    description: p.description.replace(/SNES/g, 'Dreamcast').replace(/\bEcho\b/g, 'Reverb').replace(/\becho\b/g, 'reverb'),
    channelKinds: [...p.channelKinds],
    instrument,
    ...(p.sample ? { sample: structuredClone(p.sample) } : {})
  }
}

export const DREAMCAST_BASELINE_PRESETS: Preset[] = SNES_PRESETS.map(fromSnes)

// ---------------------------------------------------------------------------------------------
// Synthwave presets (Phase D1)

/** An AEG from times: attack seconds, D1 and release as 96 dB-fall time constants (tau, seconds), the sustain level (0..1) and D2 (null = hold). */
function aegT(o: { attack: number; decay?: number; sustain?: number; sustainTau?: number | null; release: number }): AicaAeg {
  const sustain = o.sustain ?? 1
  const levelDb = -20 * Math.log10(Math.max(sustain, 1e-3))
  return {
    ar: o.attack <= 0.001 ? 31 : nearestRate(o.attack, aicaAttackSeconds),
    d1r: sustain >= 1 ? 0 : fallRate(o.decay ?? 0.3),
    d2r: o.sustainTau === undefined || o.sustainTau === null ? 0 : fallRate(o.sustainTau),
    rr: fallRate(o.release),
    dl: clampInt(levelDb / 3, 0, 31)
  }
}

/** FLV value (0..8191) of a cutoff in Hz (the inverse of flvToHz: log scale from 20 Hz at 0 to 20 kHz at 8191). */
const flv = (hz: number): number => clampInt((FLV_MAX * Math.log2(hz / 20)) / 9.965784, 0, FLV_MAX)

/** A filter-envelope rate whose sweep of `span` FLV units takes about `seconds` (attack table for rises, fall table for drops). */
function fegRate(seconds: number, span: number, rise: boolean): number {
  if (rise && seconds <= 0.001) return 31
  const full = (seconds * FLV_MAX) / Math.max(1, Math.abs(span))
  return nearestRate(full, rise ? aicaAttackSeconds : aicaFallSeconds)
}

/** A filter from cutoffs in Hz: start, attack peak, level after D1, level after D2, release target, with the sweep times in seconds. */
function filterT(o: { q: number; hz: [number, number, number, number, number]; attack: number; d1: number; d2: number; release: number }): AicaFilter {
  const l = o.hz.map(flv) as [number, number, number, number, number]
  return {
    q: o.q,
    flv: l,
    far: fegRate(o.attack, l[1] - l[0], true),
    fd1r: fegRate(o.d1, l[1] - l[2], false),
    fd2r: fegRate(o.d2, l[2] - l[3], false),
    frr: fegRate(o.release, l[3] - l[4], false)
  }
}

const vibrato = (freq: number, depth: number): AicaLfo => ({ freq, pitchWave: 'tri', pitchDepth: depth, ampWave: 'tri', ampDepth: 0, reset: true })

type Params = Record<string, number | string | boolean>

function synth(
  id: string,
  name: string,
  role: Role,
  description: string,
  slot: { id: string; label: string; recipe: string; params?: Params },
  baseNote: number,
  fields: { format?: AicaSampleInstrument['format']; aeg: AicaAeg; send: number; filter?: AicaFilter; lfo?: AicaLfo }
): Preset {
  const sample: SampleSlot = { id: slot.id, name: slot.label, source: { kind: 'recipe', recipe: slot.recipe, params: slot.params ?? {} } }
  const instrument: AicaSampleInstrument = {
    kind: 'aica-sample',
    name,
    sample: slot.id,
    baseNote,
    format: fields.format ?? 'pcm16',
    aeg: fields.aeg,
    ...(fields.filter ? { filter: fields.filter } : {}),
    ...(fields.lfo ? { lfo: fields.lfo } : {}),
    send: fields.send
  }
  return { id: `dreamcast.${id}`, name, role, description, channelKinds: ['sample'], instrument, sample }
}

/** The synthwave bank of the preset-id contract. */
export const DREAMCAST_SYNTH_PRESETS: Preset[] = [
  synth('lead.saw-detuned', 'saw-lead', 'lead', 'Detuned saw lead with a gentle LFO vibrato; the synthwave lead. DSP send 8.', { id: 'sawlead', label: 'Saw lead', recipe: 'sawlead' }, 72, { aeg: aegT({ attack: 0.006, release: 0.22 }), lfo: vibrato(19, 1), send: 8 }),
  synth('lead.sync', 'sync-lead', 'lead', 'Hard-sync lead with an LFO vibrato; cutting, for solos and counter-melodies. DSP send 8.', { id: 'syncsaw', label: 'Sync saw', recipe: 'syncsaw' }, 72, { aeg: aegT({ attack: 0.004, release: 0.15 }), lfo: vibrato(18, 2), send: 8 }),
  synth('pad.supersaw', 'supersaw', 'pad', 'Supersaw pad (4-bit ADPCM: a quarter of the RAM of pcm16): seven detuned saws, a slow swell into the chorus DSP (send 11).', { id: 'supersaw', label: 'Supersaw', recipe: 'supersaw' }, 60, { format: 'adpcm', aeg: aegT({ attack: 0.28, release: 0.7 }), send: 11 }),
  synth('pad.juno', 'juno-pad', 'pad', 'Juno-style pad (4-bit ADPCM): stacked pulse widths, baked chorus and a bloom intro; warmer than the supersaw. DSP send 12.', { id: 'junopad', label: 'Juno pad', recipe: 'junopad' }, 60, { format: 'adpcm', aeg: aegT({ attack: 0.04, release: 0.9 }), send: 12 }),
  synth(
    'bass.analog',
    'analog-bass',
    'bass',
    'Analog bass: saw plus sub square with a live filter envelope (the pluck is the AICA filter, not baked into the sample). Dry.',
    { id: 'analogbass', label: 'Analog bass', recipe: 'analogbass', params: { pluck: false, cutoff: 4000, res: 0 } },
    36,
    { aeg: aegT({ attack: 0.001, release: 0.07 }), filter: filterT({ q: 9, hz: [2400, 3600, 420, 380, 250], attack: 0.004, d1: 0.18, d2: 0.5, release: 0.15 }), send: 0 }
  ),
  synth('bass.fm', 'fm-bass', 'bass', 'DX-style FM bass: a snappy attack settling into a warm sustain. Dry; the darkwave bass.', { id: 'fmbass', label: 'FM bass', recipe: 'fmbass' }, 36, { aeg: aegT({ attack: 0.001, release: 0.08 }), send: 0 }),
  synth('bass.sub', 'sub-bass', 'bass', 'Sub bass: a low square with a trace of saw, deep and round. Dry.', { id: 'analogbass-sub', label: 'Sub bass', recipe: 'analogbass', params: { pluck: false, saw: 0.15, sub: 1, subOct: 0, cutoff: 380 } }, 36, { aeg: aegT({ attack: 0.002, release: 0.1 }), send: 0 }),
  synth('pluck.arp', 'arp-pluck', 'pluck', 'Arp pluck: two detuned saws through a closing resonant low-pass. Fast 16th arpeggios. DSP send 9.', { id: 'synthpluck', label: 'Synth pluck', recipe: 'synthpluck' }, 60, { aeg: aegT({ attack: 0.001, release: 0.08 }), send: 9 }),
  synth(
    'brass.synth-stab',
    'synth-stab',
    'brass',
    'Synth brass stab: the swell and the drop are the AICA filter envelope (the sample has only a 10 ms swell baked in), then a quick decay to a held tail. DSP send 10.',
    { id: 'synthbrass', label: 'Synth brass', recipe: 'synthbrass', params: { swell: 0.01 } },
    60,
    {
      aeg: aegT({ attack: 0.001, decay: 0.22, sustain: 0.45, sustainTau: 1.5, release: 0.18 }),
      filter: filterT({ q: 5, hz: [300, 5200, 2600, 1900, 500], attack: 0.09, d1: 0.4, d2: 1.5, release: 0.25 }),
      send: 10
    }
  ),
  synth('epiano.dx', 'dx-epiano', 'arp', 'DX-style electric piano: tine attack and a mellow body. Chords and arps, like snes.arp.epiano. DSP send 9.', { id: 'dxepiano', label: 'DX e-piano', recipe: 'dxepiano' }, 60, { aeg: aegT({ attack: 0.001, release: 0.15 }), send: 9 }),
  synth('bell.dx', 'dx-bell', 'bell', 'DX-style FM bell that rings out and fades by itself. DSP send 11.', { id: 'dxbell', label: 'DX bell', recipe: 'dxbell' }, 72, { aeg: aegT({ attack: 0.001, release: 0.5 }), send: 11 }),
  synth('kick.linn', 'linn-kick', 'kick', 'LinnDrum-style kick: punchy and short. Write at C-4. Dry.', { id: 'linnkick', label: 'Linn kick', recipe: 'linnkick' }, 60, { aeg: aegT({ attack: 0.0005, release: 0.06 }), send: 0 }),
  synth('kick.808', '808-kick', 'kick', '808-style kick: a long sine boom. Write at C-4. Dry.', { id: '808kick', label: '808 kick', recipe: '808kick' }, 60, { aeg: aegT({ attack: 0.0005, release: 0.15 }), send: 0 }),
  synth('snare.gated', 'gated-snare', 'snare', 'Gated-reverb snare with the gate baked into the sample, so it stays tight: no DSP send. Write at C-4 on beats 2 and 4.', { id: 'gatedsnare', label: 'Gated snare', recipe: 'gatedsnare' }, 60, { aeg: aegT({ attack: 0.0005, release: 0.04 }), send: 0 }),
  synth('snare.linn', 'linn-snare', 'snare', 'LinnDrum-style snare: tone and bright noise. DSP send 12.', { id: 'linnsnare', label: 'Linn snare', recipe: 'linnsnare' }, 60, { aeg: aegT({ attack: 0.0005, release: 0.05 }), send: 12 }),
  synth('clap.linn', 'linn-clap', 'clap', 'LinnDrum-style clap with a short room tail. DSP send 12.', { id: 'linnclap', label: 'Linn clap', recipe: 'linnclap' }, 60, { aeg: aegT({ attack: 0.0005, release: 0.05 }), send: 12 }),
  synth('hat.linn', 'linn-hat', 'hihat', 'LinnDrum-style closed hi-hat: a short digital tick. Dry.', { id: 'linnhat', label: 'Linn hi-hat', recipe: 'linnhat' }, 60, { aeg: aegT({ attack: 0.0005, release: 0.02 }), send: 0 }),
  synth('openhat.linn', 'linn-openhat', 'openhat', 'LinnDrum-style open hi-hat. Dry.', { id: 'linnopenhat', label: 'Linn open hat', recipe: 'linnopenhat' }, 60, { aeg: aegT({ attack: 0.0005, release: 0.04 }), send: 0 }),
  synth('tom.linn', 'linn-tom', 'tom', 'LinnDrum-style tom with a pitch sweep; play different notes for different pitches (C-3 low, C-4 mid). DSP send 8.', { id: 'linntom', label: 'Linn tom', recipe: 'linntom' }, 60, { aeg: aegT({ attack: 0.0005, release: 0.06 }), send: 8 }),
  synth('crash.linn', 'linn-crash', 'crash', 'Crash cymbal for the first beat of a section; use sparingly (large sample). DSP send 10.', { id: 'linncrash', label: 'Linn crash', recipe: 'linncrash' }, 60, { aeg: aegT({ attack: 0.0005, release: 0.3 }), send: 10 })
]

export const DREAMCAST_PRESETS: Preset[] = [...DREAMCAST_BASELINE_PRESETS, ...DREAMCAST_SYNTH_PRESETS]
