// The "gm" chip's sound engine: a General MIDI SoundFont played by spessasynth_core (pure TypeScript, no native code).
//
//   SoundFont bytes  ->  setSoundFont()  (the host loads the file: Node main process, or the app window over IPC)
//   SongPlayer       ->  one GmVoice per channel; every sequencer tick the voice turns its ChannelControl into MIDI
//                        events (program change, note on/off, pitch bend, expression, pan, reverb send) on a
//                        SoundFontBus that owns ONE spessasynth processor
//   after the voices ->  the bus renders the block and exposes it as the shared stem "_gm" (the voices themselves are
//                        silent), so all channels are one mix: per-channel stems are not available for this chip
//
// M1..M9 are MIDI channels 0-8, M10..M12 are 10-12 and the four drum voices all play on MIDI channel 9, see chips/gm.ts.
// Rendering is deterministic: the same song, sample rate and block layout give the same samples. The synth renders in
// 128-frame quanta that restart at every sequencer tick, so the worklet (128-frame blocks) and the offline renderer
// (4096-frame blocks) differ only in where envelopes are updated (inaudible), not in notes or timing.

import { type BasicSoundBank, type MIDIController, SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core'
import { gmMidiChannel } from '../../chips/gm'
import type { ChannelControl } from '../sequencer'
import type { GmConfig, Instrument, Song } from '../../types'
import { registerMixProfile } from '../mixer'
import { type AuxOutput, type ChipVoice, type VoiceArgs, markChipPlayable, registerVoice } from './types'

/** Where to get the SoundFont, quoted in every "no SoundFont" error. */
export const SOUNDFONT_URL = 'https://github.com/mrbumpy409/GeneralUser-GS'

export const SOUNDFONT_MISSING_MESSAGE =
  `The gm chip needs a SoundFont but none is loaded. Download GeneralUser-GS.sf2 from ${SOUNDFONT_URL} and put it in the "soundfonts" folder of the Chiptune Studio data folder (~/ChiptuneStudio/soundfonts/GeneralUser-GS.sf2).`

// ---------------------------------------------------------------------------------------------- SoundFont store

let sfBytes: ArrayBuffer | null = null
let sfBank: BasicSoundBank | null = null

/**
 * Hand the SoundFont file (an uncompressed .sf2) to the synth; null unloads it. The buffer is kept, not copied: do not
 * detach it (transfer it) afterwards. Parsing happens once, on first use.
 */
export function setSoundFont(data: ArrayBuffer | Uint8Array | null): void {
  let next: ArrayBuffer | null = null
  if (data) {
    if (data instanceof Uint8Array) next = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? (data.buffer as ArrayBuffer) : (data.slice().buffer as ArrayBuffer)
    else next = data
  }
  if (next !== sfBytes) sfBank = null
  sfBytes = next
}

export function hasSoundFont(): boolean {
  return sfBytes !== null
}

/** The loaded SoundFont bytes (for handing them on to a worker), or null. */
export function getSoundFontBytes(): ArrayBuffer | null {
  return sfBytes
}

function soundFontBank(): BasicSoundBank {
  if (!sfBytes) throw new Error(SOUNDFONT_MISSING_MESSAGE)
  if (!sfBank) {
    try {
      sfBank = SoundBankLoader.fromArrayBuffer(sfBytes)
    } catch (e) {
      throw new Error(`The SoundFont could not be read (${e instanceof Error ? e.message : String(e)}). Use an uncompressed .sf2 file such as GeneralUser-GS.sf2 from ${SOUNDFONT_URL}.`, { cause: e })
    }
  }
  return sfBank
}

/** Name and preset count of a SoundFont file (for soundfont_status); throws when the bytes are not a SoundFont. */
export function describeSoundFont(bytes: ArrayBuffer): { name: string; presets: number; drumKits: number } {
  const bank = SoundBankLoader.fromArrayBuffer(bytes)
  const drumKits = bank.presets.filter((p) => p.isGMGSDrum).length
  return { name: bank.soundBankInfo.name, presets: bank.presets.length, drumKits }
}

// ---------------------------------------------------------------------------------------------- bus

const QUANTUM = 128
const CC = { bank: 0, dataEntry: 6, volume: 7, pan: 10, expression: 11, dataEntryLsb: 38, allSoundOff: 120, reverb: 91, chorus: 93, rpnLsb: 100, rpnMsb: 101 }
const DRUM_CHANNEL = 9

const cc = (n: number): MIDIController => n as MIDIController

/** One spessasynth processor shared by all gm voices of a player. */
export class SoundFontBus {
  readonly proc: SpessaSynthProcessor
  /** The drum kit program currently selected on MIDI channel 9. */
  drumKit = 0
  private reverbBase = 0
  private chorusLevel = 0

  constructor(sampleRate: number, cfg: GmConfig | null) {
    const bank = soundFontBank()
    this.proc = new SpessaSynthProcessor(sampleRate, { effectsEnabled: true, eventsEnabled: false })
    this.proc.soundBankManager.addSoundBank(bank, 'gm')
    this.configure(cfg)
    for (let ch = 0; ch < 16; ch++) {
      this.proc.controllerChange(ch, cc(CC.volume), 100)
      this.proc.controllerChange(ch, cc(CC.expression), 127)
      this.proc.controllerChange(ch, cc(CC.pan), 64)
      if (ch === DRUM_CHANNEL) continue
      // pitch bend range of 12 semitones (RPN 0), so slides and vibrato of the tracker map onto the wheel
      this.proc.controllerChange(ch, cc(CC.rpnMsb), 0)
      this.proc.controllerChange(ch, cc(CC.rpnLsb), 0)
      this.proc.controllerChange(ch, cc(CC.dataEntry), 12)
      this.proc.controllerChange(ch, cc(CC.dataEntryLsb), 0)
      this.proc.controllerChange(ch, cc(CC.rpnMsb), 127)
      this.proc.controllerChange(ch, cc(CC.rpnLsb), 127)
    }
  }

  /** Re-read the effect sends from the chip config; returns true when they changed. */
  configure(cfg: GmConfig | null): boolean {
    const rev = Math.round(Math.max(0, Math.min(1, cfg?.reverb ?? 0.3)) * 127)
    const cho = Math.round(Math.max(0, Math.min(1, cfg?.chorus ?? 0.15)) * 127)
    const changed = rev !== this.reverbBase || cho !== this.chorusLevel
    this.reverbBase = rev
    this.chorusLevel = cho
    if (changed) for (let ch = 0; ch < 16; ch++) this.proc.controllerChange(ch, cc(CC.chorus), cho)
    return changed
  }

  get reverb(): number {
    return this.reverbBase
  }

  /** Render `n` frames into L/R (overwritten), in 128-frame quanta. */
  render(L: Float32Array, R: Float32Array, n: number): void {
    L.fill(0, 0, n)
    R.fill(0, 0, n)
    for (let off = 0; off < n; off += QUANTUM) this.proc.process(L, R, off, Math.min(QUANTUM, n - off))
  }
}

let currentBus: SoundFontBus | null = null

/** One bus per player: the voice of channel 0 (created first) starts a fresh one. */
function busFor(args: VoiceArgs): SoundFontBus {
  if (!currentBus || args.index === 0) {
    const cfg = args.song.chipConfig
    currentBus = new SoundFontBus(args.sampleRate, cfg.chip === 'gm' ? cfg : null)
  }
  return currentBus
}

// ---------------------------------------------------------------------------------------------- voices

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)))

class GmVoice implements ChipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 1
  readonly aux?: AuxOutput
  private readonly midi: number
  private muted = false
  // state of the MIDI channel as last sent
  private program = -1
  private bank = -1
  private sounding = -1
  private bend = 8192
  private expr = 127
  private pan = 64
  private send = -1
  private playing = false

  constructor(
    private readonly bus: SoundFontBus,
    private song: Song,
    channelId: string,
    index: number,
    private readonly drum: boolean
  ) {
    this.midi = gmMidiChannel(channelId)
    if (index === 0) this.aux = { id: '_gm', render: (L, R, n) => bus.render(L, R, n) }
  }

  private cfg(): GmConfig | null {
    const c = this.song.chipConfig
    return c.chip === 'gm' ? c : null
  }

  private stopNote(): void {
    if (this.playing) {
      this.bus.proc.noteOff(this.midi, this.sounding)
      this.playing = false
    }
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    const p = this.bus.proc
    if (this.muted) {
      this.stopNote()
      return
    }
    const send = c.echo === false ? 0 : this.bus.reverb
    if (send !== this.send) {
      this.send = send
      p.controllerChange(this.midi, cc(CC.reverb), send)
    }
    if (!c.gate) {
      this.stopNote()
      return
    }
    const pan = clampInt(64 + c.pan * 63, 1, 127)
    if (pan !== this.pan) {
      this.pan = pan
      p.controllerChange(this.midi, cc(CC.pan), pan)
    }
    if (c.trigger) {
      this.stopNote()
      const velocity = clampInt(c.rawVol * 127, 1, 127)
      if (this.drum) {
        const key = inst?.kind === 'sf-drum' ? inst.key : clampInt(c.note, 27, 87)
        const kit = inst?.kind === 'sf-drum' ? (inst.kit ?? 0) : 0
        if (kit !== this.bus.drumKit) {
          this.bus.drumKit = kit
          p.programChange(DRUM_CHANNEL, kit)
        }
        this.sounding = key
        p.noteOn(this.midi, key, velocity)
      } else {
        const program = inst?.kind === 'sf-program' ? inst.program : 0
        const bank = inst?.kind === 'sf-program' ? (inst.bank ?? 0) : 0
        if (bank !== this.bank) {
          this.bank = bank
          p.controllerChange(this.midi, cc(CC.bank), bank)
          this.program = -1
        }
        if (program !== this.program) {
          this.program = program
          p.programChange(this.midi, program)
        }
        this.sounding = clampInt(c.note, 0, 127)
        this.bend = 8192
        p.pitchWheel(this.midi, 8192)
        p.noteOn(this.midi, this.sounding, velocity)
      }
      this.playing = true
    }
    if (!this.playing || this.drum) return
    // continuous parameters of the held note: pitch (slides, portamento, vibrato), volume swing (tremolo)
    const semis = Math.max(-12, Math.min(12, c.semis - this.sounding))
    const bend = clampInt(8192 + (semis / 12) * 8191, 0, 16383)
    if (bend !== this.bend) {
      this.bend = bend
      p.pitchWheel(this.midi, bend)
    }
    const expr = clampInt(c.rawVol > 0 ? (c.vol / c.rawVol) * 127 : 127, 0, 127)
    if (expr !== this.expr) {
      this.expr = expr
      p.controllerChange(this.midi, cc(CC.expression), expr)
    }
  }

  render(buf: Float32Array, from: number, to: number): void {
    buf.fill(0, from, to)
  }

  reset(): void {
    this.stopNote()
    this.bus.proc.controllerChange(this.midi, cc(CC.allSoundOff), 0)
    this.program = -1
    this.bank = -1
    this.send = -1
  }

  setSong(song: Song): void {
    this.song = song
    if (this.bus.configure(this.cfg())) this.send = -1
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted) this.stopNote()
  }
}

registerVoice('gm', 'gm-melodic', (args) => new GmVoice(busFor(args), args.song, args.channel.id, args.index, false))
registerVoice('gm', 'gm-drums', (args) => new GmVoice(busFor(args), args.song, args.channel.id, args.index, true))
markChipPlayable('gm')

// Brings the SoundFont mix (about -22 LUFS at unity for a calm track) up to the level of the other chips; the soft limiter
// in the mixer catches the peaks.
registerMixProfile('gm', { outputGain: 1.7, filters: () => [] })
