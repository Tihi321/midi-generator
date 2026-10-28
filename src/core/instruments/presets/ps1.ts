// PS1 preset bank. Phase B0 baseline: one preset per SNES preset (same recipe slots, so the same sounds), with the
// SNES envelope mapped to PS1 ADSR register values by `snesToPsxAdsr` and SNES echo becoming the reverb send. Ids are
// `ps1.<role>.<name>` (the SNES id with its prefix swapped). Phase B tunes the mapper by ear; Phase D1 appends the
// synthwave presets of the preset-id contract (`PS1_SYNTH_PRESETS`: detuned saw and sync leads, supersaw and Juno pads,
// analog / FM / sub basses, arp pluck, brass stab, DX e-piano and bell, and a LinnDrum/808 kit with a gated snare), all from
// the generated recipes in samplegen/synth.ts. Every one plays through the 'psx' target, so the 4-bit grit stays.
//
// PS1 envelope rates (psx-spx): every rate field counts from 0 = fastest. The linear attack of rate r (shift = r >> 2,
// step = 7 - (r & 3)) adds `step << max(0, 11 - shift)` to the 15-bit level every `1 << max(0, shift - 11)` samples;
// the exponential decay/sustain/release steps scale with the level, so they are exponentials with the time constants
// computed by `psxDecayTauSec` / `psxSustainTauSec`.

import type { PsxAdsr, PsxSampleInstrument, Role, SampleSlot, SnesEnvelope, SnesSampleInstrument } from '../../types'
import type { Preset } from './types'
import { SNES_PRESETS } from './snes'
import { snesEnvTimes } from './snesTimes'

const SPU_RATE = 44100

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)))

/** Seconds of the linear attack from silence to full level for an attack rate 0..127. */
export function psxAttackSeconds(rate: number): number {
  const shift = rate >> 2
  const step = 7 - (rate & 3)
  const perCycle = step * 2 ** Math.max(0, 11 - shift)
  return (32767 / perCycle) * 2 ** Math.max(0, shift - 11) / SPU_RATE
}

/** Time constant in seconds of the exponential decrease with a shift 0..31 and a step magnitude 5..8 (release: step 8). */
function expTauSec(shift: number, stepMagnitude: number): number {
  return (32768 / (stepMagnitude * 2 ** Math.max(0, 11 - shift))) * 2 ** Math.max(0, shift - 11) / SPU_RATE
}
/** Decay phase (shift 0..15, step 8, always exponential). */
export const psxDecayTauSec = (decay: number): number => expTauSec(decay, 8)
/** Sustain phase decreasing exponentially with a rate 0..127. */
export const psxSustainTauSec = (rate: number): number => expTauSec(rate >> 2, 8 - (rate & 3))
/** Release phase (shift 0..31, step 8, exponential). */
export const psxReleaseTauSec = (release: number): number => expTauSec(release, 8)

/** The rate in 0..hi whose time (from `seconds`) is closest to `target` in ratio. */
function nearestRate(target: number, hi: number, seconds: (rate: number) => number): number {
  if (!(target > 0)) return 0
  if (!Number.isFinite(target)) return hi
  let best = 0
  let bestErr = Infinity
  for (let r = 0; r <= hi; r++) {
    const err = Math.abs(Math.log(seconds(r) / target))
    if (err < bestErr) {
      bestErr = err
      best = r
    }
  }
  return best
}

/** Approximate a SNES ADSR/GAIN envelope with PS1 ADSR values: same attack time, decay, sustain level and release. */
export function snesToPsxAdsr(env: SnesEnvelope): PsxAdsr {
  const t = snesEnvTimes(env)
  return {
    attack: nearestRate(t.attackSec, 127, psxAttackSeconds),
    attackExp: false,
    decay: nearestRate(t.decayTauSec, 15, psxDecayTauSec),
    // PS1 sustain level (n + 1) / 16 of full against the SNES (sl + 1) / 8
    sustainLevel: clampInt(t.sustainLevel * 16 - 1, 0, 15),
    // rate 127 is the slowest decrease: it holds the level
    sustainRate: t.sustainTauSec === null ? 127 : nearestRate(t.sustainTauSec, 127, psxSustainTauSec),
    sustainDir: 'dec',
    sustainExp: true,
    release: nearestRate(t.releaseTauSec, 31, psxReleaseTauSec),
    releaseExp: true
  }
}

function fromSnes(p: Preset): Preset {
  const s = p.instrument as SnesSampleInstrument
  const instrument: PsxSampleInstrument = {
    kind: 'psx-sample',
    name: s.name,
    sample: s.sample,
    baseNote: s.baseNote,
    adsr: snesToPsxAdsr(s.env),
    reverb: s.echo
  }
  return {
    id: p.id.replace(/^snes\./, 'ps1.'),
    name: p.name,
    role: p.role,
    description: p.description.replace(/SNES/g, 'PS1').replace(/\bEcho\b/g, 'Reverb').replace(/\becho\b/g, 'reverb'),
    channelKinds: [...p.channelKinds],
    instrument,
    ...(p.sample ? { sample: structuredClone(p.sample) } : {})
  }
}

export const PS1_BASELINE_PRESETS: Preset[] = SNES_PRESETS.map(fromSnes)

// ---------------------------------------------------------------------------------------------
// Synthwave presets (Phase D1)

/** A PS1 ADSR from times: linear attack in seconds, decay / sustain / release as exponential time constants (tau in seconds). */
function adsrT(o: { attack: number; decay?: number; sustain?: number; sustainTau?: number | null; release: number }): PsxAdsr {
  const sustain = o.sustain ?? 1
  return {
    attack: nearestRate(o.attack, 127, psxAttackSeconds),
    attackExp: false,
    decay: nearestRate(o.decay ?? 0.3, 15, psxDecayTauSec),
    sustainLevel: clampInt(sustain * 16 - 1, 0, 15),
    // rate 127 is the slowest decrease: it holds the level
    sustainRate: o.sustainTau === undefined || o.sustainTau === null ? 127 : nearestRate(o.sustainTau, 127, psxSustainTauSec),
    sustainDir: 'dec',
    sustainExp: true,
    release: nearestRate(o.release, 31, psxReleaseTauSec),
    releaseExp: true
  }
}

type Params = Record<string, number | string | boolean>

function synth(
  id: string,
  name: string,
  role: Role,
  description: string,
  slot: { id: string; label: string; recipe: string; params?: Params },
  baseNote: number,
  adsr: PsxAdsr,
  reverb: boolean
): Preset {
  const sample: SampleSlot = { id: slot.id, name: slot.label, source: { kind: 'recipe', recipe: slot.recipe, params: slot.params ?? {} } }
  return {
    id: `ps1.${id}`,
    name,
    role,
    description,
    channelKinds: ['sample'],
    instrument: { kind: 'psx-sample', name, sample: slot.id, baseNote, adsr, reverb },
    sample
  }
}

/** The synthwave bank of the preset-id contract: dry kick and bass, wet pads, leads, snare, claps and toms. */
export const PS1_SYNTH_PRESETS: Preset[] = [
  synth('lead.saw-detuned', 'saw-lead', 'lead', 'Detuned saw lead: two saws a few cents apart in a short loop; the synthwave lead. Reverb on.', { id: 'sawlead', label: 'Saw lead', recipe: 'sawlead' }, 72, adsrT({ attack: 0.006, release: 0.22 }), true),
  synth('lead.sync', 'sync-lead', 'lead', 'Hard-sync lead: the sync edge swings once per loop. Cutting, for solos and counter-melodies. Reverb on.', { id: 'syncsaw', label: 'Sync saw', recipe: 'syncsaw' }, 72, adsrT({ attack: 0.004, release: 0.15 }), true),
  synth('pad.supersaw', 'supersaw', 'pad', 'Supersaw pad: seven detuned saws in a 16k-sample loop, a slow swell. The wide synthwave pad. Reverb on.', { id: 'supersaw', label: 'Supersaw', recipe: 'supersaw' }, 60, adsrT({ attack: 0.28, release: 0.7 }), true),
  synth('pad.juno', 'juno-pad', 'pad', 'Juno-style pad: stacked pulse widths with a baked chorus and a filter bloom intro. Warmer than the supersaw. Reverb on.', { id: 'junopad', label: 'Juno pad', recipe: 'junopad' }, 60, adsrT({ attack: 0.04, release: 0.9 }), true),
  synth('bass.analog', 'analog-bass', 'bass', 'Analog bass: saw plus sub square through a low-pass, with a baked filter pluck. Dry; plays straight eighths well.', { id: 'analogbass', label: 'Analog bass', recipe: 'analogbass' }, 36, adsrT({ attack: 0.001, release: 0.07 }), false),
  synth('bass.fm', 'fm-bass', 'bass', 'DX-style FM bass: a snappy attack settling into a warm sustain. Dry; the darkwave bass.', { id: 'fmbass', label: 'FM bass', recipe: 'fmbass' }, 36, adsrT({ attack: 0.001, release: 0.08 }), false),
  synth('bass.sub', 'sub-bass', 'bass', 'Sub bass: a low square with a trace of saw, deep and round. Dry.', { id: 'analogbass-sub', label: 'Sub bass', recipe: 'analogbass', params: { pluck: false, saw: 0.15, sub: 1, subOct: 0, cutoff: 380 } }, 36, adsrT({ attack: 0.002, release: 0.1 }), false),
  synth('pluck.arp', 'arp-pluck', 'pluck', 'Arp pluck: two detuned saws through a closing resonant low-pass. Fast 16th arpeggios. Reverb on.', { id: 'synthpluck', label: 'Synth pluck', recipe: 'synthpluck' }, 60, adsrT({ attack: 0.001, release: 0.08 }), true),
  synth('brass.synth-stab', 'synth-stab', 'brass', 'Synth brass stab: a baked filter swell, then a quick decay to a held tail. Chord hits on the downbeat. Reverb on.', { id: 'synthbrass', label: 'Synth brass', recipe: 'synthbrass' }, 60, adsrT({ attack: 0.001, decay: 0.22, sustain: 0.45, sustainTau: 1.5, release: 0.18 }), true),
  synth('epiano.dx', 'dx-epiano', 'arp', 'DX-style electric piano: tine attack and a mellow body. Chords and arps, like snes.arp.epiano. Reverb on.', { id: 'dxepiano', label: 'DX e-piano', recipe: 'dxepiano' }, 60, adsrT({ attack: 0.001, release: 0.15 }), true),
  synth('bell.dx', 'dx-bell', 'bell', 'DX-style FM bell that rings out and fades by itself. Reverb on.', { id: 'dxbell', label: 'DX bell', recipe: 'dxbell' }, 72, adsrT({ attack: 0.001, release: 0.5 }), true),
  synth('kick.linn', 'linn-kick', 'kick', 'LinnDrum-style kick: punchy and short. Write at C-4. Dry.', { id: 'linnkick', label: 'Linn kick', recipe: 'linnkick' }, 60, adsrT({ attack: 0.0005, release: 0.06 }), false),
  synth('kick.808', '808-kick', 'kick', '808-style kick: a long sine boom. Write at C-4. Dry.', { id: '808kick', label: '808 kick', recipe: '808kick' }, 60, adsrT({ attack: 0.0005, release: 0.15 }), false),
  synth('snare.gated', 'gated-snare', 'snare', 'Gated-reverb snare with the gate baked into the sample, so it stays tight on the hardware reverb too: reverb off. Write at C-4 on beats 2 and 4.', { id: 'gatedsnare', label: 'Gated snare', recipe: 'gatedsnare' }, 60, adsrT({ attack: 0.0005, release: 0.04 }), false),
  synth('snare.linn', 'linn-snare', 'snare', 'LinnDrum-style snare: tone and bright noise. Reverb on.', { id: 'linnsnare', label: 'Linn snare', recipe: 'linnsnare' }, 60, adsrT({ attack: 0.0005, release: 0.05 }), true),
  synth('clap.linn', 'linn-clap', 'clap', 'LinnDrum-style clap with a short room tail. Reverb on.', { id: 'linnclap', label: 'Linn clap', recipe: 'linnclap' }, 60, adsrT({ attack: 0.0005, release: 0.05 }), true),
  synth('hat.linn', 'linn-hat', 'hihat', 'LinnDrum-style closed hi-hat: a short digital tick. Dry.', { id: 'linnhat', label: 'Linn hi-hat', recipe: 'linnhat' }, 60, adsrT({ attack: 0.0005, release: 0.02 }), false),
  synth('openhat.linn', 'linn-openhat', 'openhat', 'LinnDrum-style open hi-hat. Dry.', { id: 'linnopenhat', label: 'Linn open hat', recipe: 'linnopenhat' }, 60, adsrT({ attack: 0.0005, release: 0.04 }), false),
  synth('tom.linn', 'linn-tom', 'tom', 'LinnDrum-style tom with a pitch sweep; play different notes for different pitches (C-3 low, C-4 mid). Reverb on.', { id: 'linntom', label: 'Linn tom', recipe: 'linntom' }, 60, adsrT({ attack: 0.0005, release: 0.06 }), true),
  synth('crash.linn', 'linn-crash', 'crash', 'Crash cymbal for the first beat of a section; use sparingly (large sample). Reverb on.', { id: 'linncrash', label: 'Linn crash', recipe: 'linncrash' }, 60, adsrT({ attack: 0.0005, release: 0.3 }), true)
]

export const PS1_PRESETS: Preset[] = [...PS1_BASELINE_PRESETS, ...PS1_SYNTH_PRESETS]
