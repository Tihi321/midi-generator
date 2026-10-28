// MDI-10 Phase D1: the synthwave presets of the PS1 and Dreamcast banks (the preset-id contract) and the budgets they
// have to fit. The recipes themselves (determinism, loop alignment, peaks) are tested in samplegen.test.ts.
import { describe, expect, it } from 'vitest'
import { PRESET_BANKS, createSong, missingPresetSample, resolvePreset, validateInstrument, validateSong } from '../../src/core'
import { aicaRamUsage } from '../../src/core/chips/dreamcast'
import { SPU_RAM_BYTES, spuRamUsage } from '../../src/core/chips/ps1'
import { createVoice } from '../../src/core/synth/chips/types'
import '../../src/core/synth/chips/index'
import { clearSampleCache, resolveSlot } from '../../src/core/synth/samplegen'
import { aicaTargetFor } from '../../src/core/synth/samplegen/aicaAdpcm'
import { newChannelControl } from '../../src/core/synth/sequencer'
import { midiToHz } from '../../src/core/synth/tables'
import type { AicaSampleInstrument, ChipId, Instrument, PsxSampleInstrument, Role, Song } from '../../src/core/types'

const SR = 44100
type Chip = 'ps1' | 'dreamcast'
const CHIPS: Chip[] = ['ps1', 'dreamcast']

/** The preset-id contract (without the chip prefix) and the role of each (the middle part of the id; epiano.dx is an arp). */
const CONTRACT: [string, Role][] = [
  ['lead.saw-detuned', 'lead'], ['lead.sync', 'lead'], ['pad.supersaw', 'pad'], ['pad.juno', 'pad'], ['bass.analog', 'bass'], ['bass.fm', 'bass'], ['bass.sub', 'bass'],
  ['pluck.arp', 'pluck'], ['brass.stab', 'brass'], ['epiano.dx', 'arp'], ['bell.dx', 'bell'], ['kick.linn', 'kick'], ['kick.808', 'kick'], ['snare.gated', 'snare'],
  ['snare.linn', 'snare'], ['clap.linn', 'clap'], ['hat.linn', 'hihat'], ['openhat.linn', 'openhat'], ['tom.linn', 'tom'], ['crash.linn', 'crash']
]
/** Added by D1 beyond the contract: `brass.stab` is taken by the baseline bank, so the synth brass is `brass.synth-stab`. */
const EXTRA: [string, Role][] = [['brass.synth-stab', 'brass']]
/** The presets that only exist because of D1 (`<chip>.brass.stab` is a baseline preset). */
const SYNTH_IDS = [...CONTRACT.map(([id]) => id).filter((id) => id !== 'brass.stab'), ...EXTRA.map(([id]) => id)]

function chipSong(chip: Chip, presets: string[]): Song {
  const s = createSong({ chip, patternLength: 16, authenticity: 'relaxed' })
  s.orders = [s.channels.map(() => 0)]
  s.loop = null
  for (const id of presets) {
    const inst = resolvePreset(chip, id)
    const slot = missingPresetSample(s, inst)
    if (slot && !s.samples.some((x) => x.id === slot.id)) s.samples.push(slot)
    s.instruments.push(inst)
  }
  return s
}

function noteControl(midi: number): ReturnType<typeof newChannelControl> {
  const c = newChannelControl()
  c.trigger = true
  c.gate = true
  c.vol = 1
  c.rawVol = 1
  c.semis = midi
  c.freqHz = midiToHz(midi)
  c.note = midi
  c.inst = 0
  return c
}

/** Renders instrument 0 of the song on V1 for `seconds` and returns the mono voice output. */
function renderNote(song: Song, midi: number, seconds: number): Float32Array {
  const v = createVoice({ song, channel: song.channels[0]!, index: 0, sampleRate: SR, maxBlock: 4096 })
  v.control(noteControl(midi), song.instruments[0])
  const out = new Float32Array(Math.round(seconds * SR))
  for (let off = 0; off < out.length; off += 4096) v.render(out.subarray(off, Math.min(out.length, off + 4096)), 0, Math.min(4096, out.length - off))
  return out
}

/** f0 by normalised autocorrelation with parabolic refinement. */
function autocorrHz(x: Float32Array, sr: number, minHz: number, maxHz: number): number {
  const minLag = Math.floor(sr / maxHz)
  const maxLag = Math.ceil(sr / minHz)
  const n = x.length - maxLag - 1
  const r = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0
    for (let i = 0; i < n; i++) s += x[i]! * x[i + lag]!
    r[lag] = s
  }
  let best = minLag
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag]! > r[best]!) best = lag
  const a = r[best - 1]!
  const b = r[best]!
  const c = r[best + 1]!
  const d = a - 2 * b + c
  return sr / (best + (d === 0 ? 0 : (0.5 * (a - c)) / d))
}

/** Goertzel power of x at hz. */
function power(x: Float32Array, hz: number): number {
  const w = (2 * Math.PI * hz) / SR
  const k = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (const v of x) {
    const s0 = v + k * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2
}

const energy = (x: ArrayLike<number>, from = 0, to = x.length): number => {
  let e = 0
  for (let i = from; i < to; i++) e += x[i]! * x[i]!
  return e
}

const PITCHED = ['lead.saw-detuned', 'lead.sync', 'pad.supersaw', 'pad.juno', 'bass.analog', 'bass.fm', 'bass.sub', 'pluck.arp', 'brass.stab', 'brass.synth-stab', 'epiano.dx']

describe.each(CHIPS)('%s synthwave presets', (chip) => {
  const bank = PRESET_BANKS[chip]

  it('every contract id exists with exactly that id and the role of its middle part', () => {
    for (const [id, role] of [...CONTRACT, ...EXTRA]) {
      const p = bank.find((x) => x.id === `${chip}.${id}`)
      expect(p, id).toBeDefined()
      expect(p!.role, id).toBe(role)
      expect(p!.channelKinds, id).toEqual(['sample'])
      expect(p!.sample, id).toBeDefined()
    }
  })

  it('ids and instrument names are unique within the bank, and the baseline presets are still first', () => {
    expect(new Set(bank.map((p) => p.id)).size).toBe(bank.length)
    expect(new Set(bank.map((p) => p.instrument.name)).size).toBe(bank.length)
    expect(bank[0]!.id).toBe(`${chip}.strings.ensemble`)
    expect(bank.length).toBe(33 + SYNTH_IDS.length)
  })

  it('every synthwave preset resolves, validates, brings its own sample slot and generates through its chip target', () => {
    for (const [id] of [...CONTRACT, ...EXTRA]) {
      const full = `${chip}.${id}`
      const inst = resolvePreset(chip, full)
      expect(validateInstrument(inst), full).toEqual([])
      expect(inst.presetId).toBe(full)
      const song = chipSong(chip, [full])
      const slot = song.samples[0]!
      expect(slot.id, full).toBe((inst as PsxSampleInstrument).sample)
      expect(missingPresetSample(song, inst), full).toBeUndefined()
      const target = chip === 'ps1' ? 'psx' : aicaTargetFor((inst as AicaSampleInstrument).format)
      const r = resolveSlot(slot, target)
      expect(r.pcm.length, full).toBeGreaterThan(0)
      const peak = Math.max(...r.pcm.map(Math.abs)) / 32767
      expect(peak, full).toBeGreaterThan(0.3)
      expect(peak, full).toBeLessThan(1)
    }
  })

  it.each(PITCHED)('%s sounds at its base note and an octave above', (id) => {
    const song = chipSong(chip, [`${chip}.${id}`])
    const base = (song.instruments[0] as { baseNote: number }).baseNote
    for (const note of [base, base + 12]) {
      const x = renderNote(song, note, 0.3).subarray(Math.round(0.06 * SR))
      const target = midiToHz(note)
      const hz = autocorrHz(x, SR, target * 0.7, target * 1.4)
      expect(hz / target, `${id} note ${note}`).toBeGreaterThan(0.98)
      expect(hz / target, `${id} note ${note}`).toBeLessThan(1.02)
    }
  })

  it('the DX bell sounds at its base note (its strongest partial near the fundamental is the fundamental)', () => {
    const song = chipSong(chip, [`${chip}.bell.dx`])
    const x = renderNote(song, 72, 0.4).subarray(Math.round(0.02 * SR))
    const f0 = midiToHz(72)
    let best = f0 * 0.9
    let bestP = 0
    for (let hz = f0 * 0.9; hz <= f0 * 1.1; hz += f0 * 0.002) {
      const p = power(x, hz)
      if (p > bestP) {
        bestP = p
        best = hz
      }
    }
    expect(best / f0).toBeGreaterThan(0.985)
    expect(best / f0).toBeLessThan(1.015)
  })

  it('the gated snare stops dead at its gate: nothing sounds after it, and the tail before it is real', () => {
    const song = chipSong(chip, [`${chip}.snare.gated`])
    const slot = song.samples[0]!
    const gate = (slot.source.kind === 'recipe' ? (slot.source.params['gate'] as number | undefined) : undefined) ?? 0.28
    const x = renderNote(song, 60, 1)
    const total = energy(x)
    const afterGate = energy(x, Math.round((gate + 0.01) * SR))
    expect(total).toBeGreaterThan(0)
    // < -40 dB below the whole hit (it is digital silence: the sample ends at the gate)
    expect(10 * Math.log10(Math.max(afterGate, 1e-30) / total)).toBeLessThan(-40)
    // the reverb tail: the last 40% of the gated window still carries energy (above -30 dB against the whole hit)
    const tail = energy(x, Math.round(gate * 0.6 * SR), Math.round(gate * SR))
    expect(10 * Math.log10(tail / total)).toBeGreaterThan(-30)
    // and the raw sample ends silent
    const r = resolveSlot(slot, chip === 'ps1' ? 'psx' : 'aica16')
    expect(Math.abs(r.pcm[r.pcm.length - 1]!)).toBeLessThan(400)
  })

  it('an octave up shortens the one-shot drums and the sample ends the voice (no hang)', () => {
    const song = chipSong(chip, [`${chip}.kick.808`])
    const x = renderNote(song, 60, 1.5)
    expect(energy(x, 0, SR)).toBeGreaterThan(0)
    // the 808 sample is 0.9 s: after it the voice is silent
    expect(energy(x, Math.round(1.1 * SR))).toBe(0)
  })

  it('renders are bit-identical between runs', () => {
    const song = chipSong(chip, [`${chip}.pad.supersaw`])
    const a = renderNote(song, 60, 0.3)
    clearSampleCache()
    const b = renderNote(chipSong(chip, [`${chip}.pad.supersaw`]), 60, 0.3)
    expect(Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer))).toBe(0)
  })

  it('all synthwave presets at once fit the RAM budget with the default effect settings', () => {
    const song = chipSong(chip, SYNTH_IDS.map((id) => `${chip}.${id}`))
    const issues = validateSong(song).filter((i) => i.severity === 'error' || /RAM/.test(i.message))
    expect(issues).toEqual([])
    if (chip === 'ps1') {
      expect(song.chipConfig.chip === 'ps1' && song.chipConfig.reverb.preset).toBe('studio-large')
      const u = spuRamUsage(song)
      expect(u.total).toBeLessThan(SPU_RAM_BYTES * 0.5)
      // the whole bank (baseline + synthwave) fits too
      const all = chipSong(chip, bank.map((p) => p.id))
      expect(spuRamUsage(all).total).toBeLessThan(SPU_RAM_BYTES)
    } else {
      expect(song.chipConfig.chip === 'dreamcast' && song.chipConfig.dsp.preset).toBe('chorus-hall')
      expect(aicaRamUsage(song).total).toBeLessThan(2 * 1024 * 1024 * 0.5)
      expect(aicaRamUsage(chipSong(chip, bank.map((p) => p.id))).total).toBeLessThan(2 * 1024 * 1024)
    }
  })

  it('generation is quick on a cold cache (the voice constructor warms every sample on the audio thread; wall-clock sensitive)', () => {
    clearSampleCache()
    const times: [string, number][] = []
    const target = (inst: Instrument): string => (chip === 'ps1' ? 'psx' : aicaTargetFor((inst as AicaSampleInstrument).format))
    const t0 = performance.now()
    for (const id of SYNTH_IDS) {
      const full = `${chip}.${id}`
      const song = chipSong(chip, [full])
      const t = performance.now()
      resolveSlot(song.samples[0]!, target(song.instruments[0]!))
      times.push([id, performance.now() - t])
    }
    const total = performance.now() - t0
    const slowest = [...times].sort((a, b) => b[1] - a[1])[0]!
    expect(slowest[1], `slowest ${slowest[0]}`).toBeLessThan(400)
    expect(total, 'all synthwave presets').toBeLessThan(2000)
  })
})

describe('PS1 synthwave presets', () => {
  const ps1 = (id: string): PsxSampleInstrument => resolvePreset('ps1', `ps1.${id}`) as PsxSampleInstrument

  it('use the psx target with ADSR; pads, leads, snare and claps send to the reverb, kick and bass are dry', () => {
    for (const id of ['lead.saw-detuned', 'lead.sync', 'pad.supersaw', 'pad.juno', 'snare.linn', 'clap.linn']) {
      expect(ps1(id).kind).toBe('psx-sample')
      expect(ps1(id).reverb, id).toBe(true)
    }
    for (const id of ['kick.linn', 'kick.808', 'bass.analog', 'bass.fm', 'bass.sub']) expect(ps1(id).reverb, id).toBe(false)
  })

  it('the pads swell and the plucks are instant (attack, release and sustain summaries)', () => {
    expect(ps1('pad.supersaw').adsr.attack).toBeGreaterThan(ps1('lead.saw-detuned').adsr.attack)
    expect(ps1('pad.supersaw').adsr.sustainLevel).toBe(15)
    expect(ps1('pad.juno').adsr.release).toBeGreaterThan(ps1('bass.analog').adsr.release)
    // the stab decays to about half level
    expect(ps1('brass.synth-stab').adsr.sustainLevel).toBeLessThan(10)
    expect(ps1('brass.synth-stab').adsr.sustainLevel).toBeGreaterThan(4)
  })
})

describe('Dreamcast synthwave presets', () => {
  const dc = (id: string): AicaSampleInstrument => resolvePreset('dreamcast', `dreamcast.${id}`) as AicaSampleInstrument

  it('use the AICA features: filter envelopes on the stab and the analog bass, LFO vibrato on the leads', () => {
    for (const id of ['brass.synth-stab', 'bass.analog']) {
      const f = dc(id).filter
      expect(f, id).toBeDefined()
      expect(f!.flv[1], id).toBeGreaterThan(f!.flv[2]!)
      expect(f!.flv[0], id).toBeLessThan(f!.flv[1]!)
    }
    for (const id of ['lead.saw-detuned', 'lead.sync']) {
      const l = dc(id).lfo
      expect(l, id).toBeDefined()
      expect(l!.pitchDepth).toBeGreaterThanOrEqual(1)
      expect(l!.pitchDepth).toBeLessThanOrEqual(2)
      expect(l!.reset).toBe(true)
    }
    // no baked sweep in the sample that has the live filter
    const slot = chipSong('dreamcast', ['dreamcast.brass.synth-stab']).samples[0]!
    expect(slot.source.kind === 'recipe' && slot.source.params['swell']).toBe(0.01)
    const bass = chipSong('dreamcast', ['dreamcast.bass.analog']).samples[0]!
    expect(bass.source.kind === 'recipe' && bass.source.params['pluck']).toBe(false)
  })

  it('pads send 10-12 into the DSP and use ADPCM; the drums are pcm16', () => {
    for (const id of ['pad.supersaw', 'pad.juno']) {
      expect(dc(id).send, id).toBeGreaterThanOrEqual(10)
      expect(dc(id).send, id).toBeLessThanOrEqual(12)
      expect(dc(id).format, id).toBe('adpcm')
    }
    for (const id of ['kick.linn', 'kick.808', 'snare.gated', 'snare.linn', 'clap.linn', 'hat.linn', 'openhat.linn', 'tom.linn', 'crash.linn']) expect(dc(id).format, id).toBe('pcm16')
  })

  it('the live filter envelope sweeps the bass: bright at the attack, dark in the sustain, unlike the same bass without a filter', () => {
    const filtered = renderNote(chipSong('dreamcast', ['dreamcast.bass.analog']), 36, 0.5)
    const open = chipSong('dreamcast', ['dreamcast.bass.analog'])
    delete (open.instruments[0] as AicaSampleInstrument).filter
    const plain = renderNote(open, 36, 0.5)
    // brightness: energy of the first difference over the energy of the signal
    const bright = (x: Float32Array, from: number, to: number): number => {
      const seg = x.subarray(Math.round(from * SR), Math.round(to * SR))
      const d = new Float32Array(seg.length - 1)
      for (let i = 1; i < seg.length; i++) d[i - 1] = seg[i]! - seg[i - 1]!
      return energy(d) / Math.max(energy(seg), 1e-12)
    }
    const sweep = bright(filtered, 0.004, 0.04) / bright(filtered, 0.3, 0.5)
    const sweepPlain = bright(plain, 0.004, 0.04) / bright(plain, 0.3, 0.5)
    expect(sweep).toBeGreaterThan(2)
    expect(sweepPlain).toBeLessThan(1.5)
  })
})

describe('chip ids', () => {
  it('only the two sample chips carry the synthwave bank', () => {
    for (const chip of ['nes', 'gb', 'genesis', 'snes', 'pce'] as ChipId[]) expect(PRESET_BANKS[chip].some((p) => p.id.includes('.linn') || p.id.includes('supersaw'))).toBe(false)
  })
})
