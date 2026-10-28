import { describe, expect, it } from 'vitest'
import { createSong } from '../../../src/core'
import { type SendBus, SharedBus } from '../../../src/core/synth/sampler/bus'
import { DspClock } from '../../../src/core/synth/sampler/clock'
import { SamplePlayback } from '../../../src/core/synth/sampler/playback'
import { SamplerVoice } from '../../../src/core/synth/sampler/voice'
import { estimateSampleLength } from '../../../src/core/chips'
import { additiveLoop } from '../../../src/core/synth/samplegen/generators'
import { generateRaw, getSampleTarget, pcmToBase64, registerSampleTarget, resolveSlot, sampleTargetBytes, tryPeekSampleLength, tryResolveSampleSlot } from '../../../src/core/synth/samplegen'
import { type ChannelControl, newChannelControl } from '../../../src/core/synth/sequencer'
import { midiToHz } from '../../../src/core/synth/tables'
import type { Instrument, SnesSampleInstrument, Song } from '../../../src/core/types'

describe('DspClock', () => {
  it('passes a constant through (cubic resampler, 32 kHz -> 44.1 kHz and 44.1 -> 48)', () => {
    for (const [dsp, sr] of [[32000, 44100], [44100, 48000], [44100, 44100]] as const) {
      const clock = new DspClock(dsp, sr)
      expect(clock.inc).toBe(dsp / sr)
      const steps = 400
      const outL = new Float32Array(steps).fill(0.5)
      const outR = new Float32Array(steps).fill(-0.25)
      const L = new Float32Array(128)
      const R = new Float32Array(128)
      // a few blocks: the 4-sample history fills during the first one
      for (let b = 0; b < 4; b++) clock.resampleStereo(outL, outR, Math.ceil(128 * clock.inc) + 1, L, R, 128)
      for (let i = 0; i < 128; i++) {
        expect(L[i]).toBeCloseTo(0.5, 6)
        expect(R[i]).toBeCloseTo(-0.25, 6)
      }
    }
  })

  it('reset clears the history', () => {
    const clock = new DspClock(32000, 44100)
    const a = new Float32Array(64).fill(1)
    clock.resampleStereo(a, a, 64, new Float32Array(64), new Float32Array(64), 64)
    clock.reset()
    expect(clock.frac).toBe(0)
    expect(clock.a3).toBe(0)
    expect(clock.k).toBe(0)
  })
})

describe('SamplePlayback', () => {
  const ramp = Int16Array.from({ length: 8 }, (_, i) => (i + 1) * 1000)

  it('loops at loopStart', () => {
    const pb = new SamplePlayback('gauss')
    pb.load(ramp, 4)
    pb.restart()
    pb.pitch = 0x1000
    const seen: number[] = []
    let ended = false
    for (let i = 0; i < 16; i++) {
      ended = ended || pb.advance()
      seen.push(pb.h3)
    }
    expect(ended).toBe(false)
    expect(seen).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 5000, 6000, 7000, 8000, 5000, 6000, 7000, 8000])
  })

  it('reports the end of a one-shot and then feeds silence', () => {
    const pb = new SamplePlayback('gauss')
    pb.load(ramp, undefined)
    expect(pb.loopStart).toBe(-1)
    pb.restart()
    const ends: boolean[] = []
    for (let i = 0; i < 10; i++) ends.push(pb.advance())
    expect(ends).toEqual([false, false, false, false, false, false, false, false, true, true])
    expect(pb.h3).toBe(0)
    // a loop start past the end counts as no loop
    pb.load(ramp, 99)
    expect(pb.loopStart).toBe(-1)
  })

  it('moves by the 12-bit pitch counter (0x800 = every other step)', () => {
    const pb = new SamplePlayback('none')
    pb.load(ramp, 0)
    pb.restart()
    pb.pitch = 0x800
    const rps: number[] = []
    for (let i = 0; i < 6; i++) {
      pb.advance()
      rps.push(pb.rp)
    }
    expect(rps).toEqual([0, 1, 1, 2, 2, 3])
    // the offset is added to the pitch for the step it is set for
    pb.pitchOffset = 0x800
    const before = pb.rp
    pb.advance()
    expect(pb.rp).toBe(before + 1)
  })

  it('gauss, linear and none keep DC at every phase', () => {
    const dc = new Int16Array(64).fill(10000)
    for (const mode of ['gauss', 'linear', 'none'] as const) {
      const pb = new SamplePlayback(mode)
      pb.load(dc, 0)
      pb.restart()
      for (const pitch of [0x1000, 0x0b33, 0x0555, 0x2001]) {
        pb.pitch = pitch
        for (let i = 0; i < 40; i++) {
          pb.advance()
          if (i > 8) expect(pb.interpolate(), `${mode} pitch ${pitch}`).toBeCloseTo(10000 / 32768, mode === 'gauss' ? 3 : 9)
        }
      }
    }
  })

  it('linear interpolation is exact between the middle two taps', () => {
    const pb = new SamplePlayback('linear')
    pb.load(Int16Array.from([0, 0, 4096, 8192, 8192, 8192]), undefined)
    pb.restart()
    pb.pitch = 0x1000
    pb.advance() // h3 = 0
    pb.advance() // h3 = 0
    pb.advance() // h3 = 4096 -> h1 = 0, h2 = 0
    pb.advance() // h3 = 8192 -> h1 = 0, h2 = 4096
    pb.cnt = 0x800
    expect(pb.h1).toBe(0)
    expect(pb.h2).toBe(4096)
    expect(pb.interpolate()).toBeCloseTo(2048 / 32768, 9)
  })
})

describe('SharedBus', () => {
  const stub = (): SendBus => ({
    sendL: new Float32Array(8),
    sendR: new Float32Array(8),
    steps: 0,
    configure() {},
    reset() {},
    render() {}
  })
  it('hands every voice the bus of channel 0 and starts a fresh one with a new channel 0', () => {
    let made = 0
    const shared = new SharedBus<SendBus>(() => {
      made++
      return stub()
    })
    const song = createSong({ chip: 'snes' })
    const args = (index: number) => ({ song, channel: song.channels[index]!, index, sampleRate: 44100, maxBlock: 128 })
    const b0 = shared.get(args(0))
    expect(shared.get(args(1))).toBe(b0)
    expect(shared.get(args(2))).toBe(b0)
    expect(made).toBe(1)
    expect(shared.get(args(0))).not.toBe(b0)
    expect(made).toBe(2)
  })
})

// A tiny chip on the shared core: full-level envelope, 44.1 kHz DSP, linear interpolation, with both optional hooks.
class TestBus implements SendBus {
  readonly sendL = new Float32Array(512)
  readonly sendR = new Float32Array(512)
  steps = 0
  configure(): void {}
  reset(): void {}
  render(): void {}
}

class TestVoice extends SamplerVoice<SnesSampleInstrument> {
  constructor(args: ConstructorParameters<typeof SamplerVoice>[0], bus: SendBus) {
    super(args, bus, { dspRate: 44100, interp: 'linear', target: 'snes', pitchMax: 0x4000, linearGain: 1, auxId: '_test' })
  }
  protected instOf(inst: Instrument | undefined): SnesSampleInstrument | null {
    return inst && inst.kind === 'snes-sample' ? inst : null
  }
  protected sendLevelOf(c: ChannelControl, e: SnesSampleInstrument): number {
    return (c.echo ?? e.echo) ? 0.5 : 0
  }
  protected envParams(): void {}
  protected envStart(): void {}
  protected envStep(): void {}
  protected envRelease(): void {
    this.active = false
    this.keyed = false
  }
  protected envGain(): number {
    return 1
  }
  protected envSounding(): boolean {
    return true
  }
  protected beginDeclick(): void {
    this.finishDeclick()
  }
  protected envReset(): void {}
  protected onSampleEnd(): void {
    this.active = false
    this.keyed = false
  }
  get pitch(): number {
    return this.playback.pitch
  }
}

/** The same chip with both optional hooks: counts the steps and halves the sample. */
class HookedVoice extends TestVoice {
  pre = 0
  post = 0
  protected override preStep(): void {
    this.pre++
  }
  protected override postSample(s: number): number {
    this.post++
    return s * 0.5
  }
}

function dcSong(): Song {
  const song = createSong({ chip: 'snes', patternLength: 16, authenticity: 'relaxed' })
  song.samples.push({ id: 'dc', name: 'dc', source: { kind: 'pcm', sampleRate: 32000, data: pcmToBase64(new Int16Array(512).fill(16384)) }, loopStart: 0 })
  song.instruments.push({ kind: 'snes-sample', name: 'dc', sample: 'dc', baseNote: 60, env: { adsr: [15, 7, 7, 0] }, echo: true })
  return song
}

function noteOn(): ChannelControl {
  const c = newChannelControl()
  c.trigger = true
  c.gate = true
  c.vol = 1
  c.freqHz = midiToHz(60)
  c.note = 60
  c.inst = 0
  return c
}

describe('SamplerVoice template', () => {
  it('runs key-on, send, the optional hooks and release through the hooks of a chip', () => {
    const song = dcSong()
    const args = { song, channel: song.channels[0]!, index: 0, sampleRate: 44100, maxBlock: 128 }
    const bus = new TestBus()
    const v = new HookedVoice(args, bus)
    expect(v.aux?.id).toBe('_test')
    expect(new HookedVoice({ ...args, index: 1 }, bus).aux).toBeUndefined()
    v.control(noteOn(), song.instruments[0])
    expect(v.pitch).toBe(Math.round((32000 / 44100) * 0x1000))
    const out = new Float32Array(128)
    v.render(out, 0, 128)
    expect(v.pre).toBeGreaterThan(80)
    expect(v.post).toBe(v.pre)
    expect(bus.steps).toBe(v.pre)
    // postSample halves the sample (a plain sample is ~0.5), the send is 0.5 of the dry level
    expect(out[127]).toBeCloseTo(0.25, 1)
    expect(bus.sendL[100]).toBeCloseTo(out[127]! * 0.5, 2)
    expect(bus.sendR[100]).toBeCloseTo(out[127]! * 0.5, 2)
    // key-off
    const off = newChannelControl()
    v.control(off, song.instruments[0])
    v.render(out, 0, 128)
    expect(out[127]).toBe(0)
  })

  it('without overrides the lean step gives the plain sample, the hooks halve it', () => {
    const song = dcSong()
    const args = { song, channel: song.channels[0]!, index: 0, sampleRate: 44100, maxBlock: 128 }
    const hooked = new HookedVoice(args, new TestBus())
    const plain = new TestVoice(args, new TestBus())
    hooked.control(noteOn(), song.instruments[0])
    plain.control(noteOn(), song.instruments[0])
    const a = new Float32Array(128)
    const b = new Float32Array(128)
    hooked.render(a, 0, 128)
    plain.render(b, 0, 128)
    expect(b[127]).toBeCloseTo(0.5, 1)
    expect(a[127]).toBeCloseTo(b[127]! * 0.5, 6)
  })

  it('a retrigger on a sounding voice goes through beginDeclick and starts the new note', () => {
    const song = dcSong()
    const args = { song, channel: song.channels[0]!, index: 0, sampleRate: 44100, maxBlock: 128 }
    const v = new TestVoice(args, new TestBus())
    v.control(noteOn(), song.instruments[0])
    v.render(new Float32Array(128), 0, 128)
    const c = noteOn()
    c.freqHz = midiToHz(72)
    v.control(c, song.instruments[0])
    expect(v.pitch).toBe(Math.round((32000 / 44100) * 0x2000))
    v.render(new Float32Array(128), 0, 128)
  })
})

describe('sample targets', () => {
  const slot = { id: 's', name: 's', source: { kind: 'recipe' as const, recipe: 'bell', params: {} } }

  it('snes and raw are registered with their byte rules', () => {
    expect(getSampleTarget('snes')?.bytes(32)).toBe(18)
    expect(getSampleTarget('raw')?.bytes(32)).toBe(64)
    expect(sampleTargetBytes('snes', 17)).toBe(18)
    expect(getSampleTarget('nope')).toBeUndefined()
    expect(tryResolveSampleSlot({ samples: [slot] }, 's', 'nope')).toBeUndefined()
  })

  it('the default target is the SNES one and keeps its numbers', () => {
    const snes = resolveSlot(slot)
    expect(resolveSlot(slot, 'snes')).toBe(snes)
    expect(snes.loopStart === undefined || snes.loopStart % 16 === 0).toBe(true)
    expect(tryPeekSampleLength(slot)).toBe(snes.pcm.length)
    expect(tryPeekSampleLength(slot, 'raw')).toBe(resolveSlot(slot, 'raw').pcm.length)
    expect(estimateSampleLength(slot)).toBe(snes.pcm.length)
    expect(estimateSampleLength(slot, undefined, 'raw')).toBe(resolveSlot(slot, 'raw').pcm.length)
  })

  it('a registered target processes recipes and user PCM and is cached under its own prefix', () => {
    registerSampleTarget('test-half', {
      process: (raw) => ({ ...raw, pcm: raw.pcm.subarray(0, raw.pcm.length >> 1), ...(raw.loopStart !== undefined ? { loopStart: raw.loopStart >> 1 } : {}) }),
      userPcm: (raw) => ({ ...raw, pcm: raw.pcm.subarray(0, 4) }),
      bytes: (n) => n,
      userRate: 22050
    })
    const raw = resolveSlot(slot, 'raw')
    const half = resolveSlot(slot, 'test-half')
    expect(half.pcm.length).toBe(raw.pcm.length >> 1)
    expect(resolveSlot(slot, 'test-half')).toBe(half)
    const user = { id: 'u', name: 'u', source: { kind: 'pcm' as const, sampleRate: 44100, data: pcmToBase64(new Int16Array(100).fill(5)) } }
    expect(resolveSlot(user, 'test-half').pcm.length).toBe(4)
    expect(resolveSlot(user, 'raw').pcm.length).toBe(100)
    expect(estimateSampleLength(user, undefined, 'test-half')).toBe(50)
    expect(estimateSampleLength(user)).toBe(Math.round((100 * 32000) / 44100))
  })

  it('additiveLoop picks the native rate near targetRate (default 32000)', () => {
    const spec = { note: 60, loopLen: 2048, harmonics: (h: number) => 1 / h, seed: 1 }
    const a = additiveLoop(spec)
    expect(additiveLoop({ ...spec, targetRate: 32000 }).rate).toBe(a.rate)
    expect(Math.abs(a.rate - 32000)).toBeLessThan(3000)
    const b = additiveLoop({ ...spec, targetRate: 44100 })
    expect(Math.abs(b.rate - 44100)).toBeLessThan(4000)
    expect(b.loopStart).toBeDefined()
  })

  it('recipe params keep the 32 kHz rate ceiling', () => {
    expect(() => generateRaw('hat', { rate: 40000 })).toThrow(/4000..32000/)
    expect(generateRaw('hat', { rate: 32000 }).sampleRate).toBe(32000)
  })
})
