// Chip-agnostic, tick-based pattern sequencer. Each call to `tick()` advances the song by one tick and
// refreshes `controls` (one reusable ChannelControl per channel) that chip voices turn into sound.
//
// Effect semantics (documented here once, relied on by the tests and the LLM guide):
//  - Pitch/volume effects 0xy 1xx 2xx 3xx 4xy 7xy Axy Pxx are "sticky": they stay active on following rows
//    until the same effect is written with parameter 00 (Pxx until changed). A new note (not under
//    portamento) clears 1xx/2xx/Qxy/Rxy slides; vibrato/tremolo phases restart on every new note.
//  - Slides/portamento/note slides/volume slide are applied on every tick of a row except tick 0.
//  - 1xx / 2xx: pitch moves xx/16 semitone per tick. 3xx: glides towards the next note at xx/16 semitone per
//    tick without retriggering (needs a sounding note). Qxy/Rxy: from the row's note, slide x*2+1 sixteenth
//    semitones per tick up/down by y semitones, then hold.
//  - 4xy: vibrato, x = phase step per tick (of 64), y = depth in sixteenths of a semitone (+- y/16).
//  - 7xy: tremolo, same speed, y/16 = depth (volume multiplier swings between 1 and 1 - y/16).
//  - Axy: volume slide (x - y) / 4 volume units (0..15) per tick.
//  - 0xy arpeggio cycles base, +x, +y by tick-in-row. Gxx delays the row's note by xx ticks (dropped if
//    xx >= row ticks). Sxx cuts the note (hard silence) at tick xx of the row.
//  - Wxx overrides the timbre macro until changed. Xxx pan (00 left, 80 centre, FF right). Exx echo on/off.
//  - Note 'off' = hard silence (gate false, release false). Note 'rel' = release: macros with a release point
//    jump to it; if the volume macro has no release point the volume goes to 0 (gate false, release true).
//  - Fxx: < 0x20 sets ticks per row (and disables the groove), >= 0x20 sets the BPM.

import type { Cell, Instrument, Macro, Macros, NoteValue, Song } from '../types'
import {
  type NextPos,
  type RowFlow,
  newRowFlow,
  nextPosition,
  resolvePatterns,
  rowTicksFor,
  samplesPerTick,
  scanRowFlow
} from './flow'
import { clamp, midiToHz } from './tables'

export interface ChannelControl {
  /** True on the single tick a new note starts (voices restart phase/envelopes). */
  trigger: boolean
  /** Key held. False after 'off', 'rel', cut, or before the first note. */
  gate: boolean
  /** True after a 'rel' until the next trigger (soft key-off; envelope chips release instead of cutting). */
  release: boolean
  /** Final pitch in Hz (arp, slides, vibrato, fine pitch and pitch macro applied). */
  freqHz: number
  /** Final pitch in fractional MIDI semitones. */
  semis: number
  /** Final volume 0..1: cell volume x vol macro x tremolo; 0 when silent (macro-based chips use this only). */
  vol: number
  /** Cell volume 0..1 without macro/tremolo and independent of the gate (envelope chips use this). */
  rawVol: number
  /** Wxx / timbre macro value; -1 = use the instrument's default. */
  timbre: number
  /** -1..1 */
  pan: number
  /** Instrument index; -1 = none. */
  inst: number
  /** The held note (MIDI, no effects). */
  note: number
  echo?: boolean
}

export function newChannelControl(): ChannelControl {
  return {
    trigger: false,
    gate: false,
    release: false,
    freqHz: 440,
    semis: 69,
    vol: 0,
    rawVol: 1,
    timbre: -1,
    pan: 0,
    inst: -1,
    note: 60
  }
}

class ChState {
  inst = -1
  volF = 15
  gate = false
  released = false
  volTail = false
  note = 60
  cur = 60
  trigger = false
  mVol = 0
  mArp = 0
  mPitch = 0
  mTim = 0
  pitchAcc = 0
  arpX = 0
  arpY = 0
  slide = 0
  portaRate = 0
  portaTarget = NaN
  qrRate = 0
  qrTarget = NaN
  vibSpeed = 0
  vibDepth = 0
  vibPhase = 0
  tremSpeed = 0
  tremDepth = 0
  tremPhase = 0
  volSlide = 0
  fine = 0
  fxTimbre = -1
  panFx = NaN
  echo: boolean | undefined = undefined
  delay = -1
  dNote: NoteValue | undefined = undefined
  dInst: number | undefined = undefined
  dVol: number | undefined = undefined
  cut = -1
  /** Pending Qxy/Rxy for the current row (applied after the note). */
  qrDir = 0
  qrX = 0
  qrY = 0
}

export function macrosOf(inst: Instrument | undefined): Macros | undefined {
  if (!inst) return undefined
  return 'macros' in inst ? inst.macros : undefined
}

function nextMacroPos(m: Macro, pos: number, released: boolean): number {
  const n = m.values.length
  let p = pos + 1
  if (!released && m.release !== undefined && m.release < n && p >= m.release) {
    if (m.loop !== undefined && m.loop < m.release) return m.loop
    return Math.max(0, m.release - 1)
  }
  if (p >= n) {
    if (m.loop !== undefined && m.loop < n && (!released || m.release === undefined || m.loop >= m.release)) p = m.loop
    else p = n - 1
  }
  return p
}

export interface SeqPosition {
  order: number
  row: number
  /** Tick within the row of the last produced tick. */
  tick: number
}

export class Sequencer {
  song: Song
  readonly controls: ChannelControl[] = []
  ended = false
  /** Ticks produced since the start (or the last seek). */
  absTick = 0
  /** Current tempo state (Fxx may change it). */
  bpm: number
  /** Ticks per row when no groove (Fxx may change it). */
  speed: number
  grooveOn = true

  private chans: ChState[] = []
  private patterns: ReturnType<typeof resolvePatterns> = []
  private order = 0
  private row = 0
  private rowLoaded = false
  private tickInRow = 0
  private rowTicks = 1
  private readonly flow: RowFlow = newRowFlow()
  private readonly next: NextPos = { order: 0, row: 0, end: false }

  constructor(song: Song, startOrder = 0, startRow = 0) {
    this.song = song
    this.bpm = song.timing.bpm
    this.speed = song.timing.speed
    this.patterns = resolvePatterns(song)
    this.resetChannels()
    this.order = startOrder
    this.row = startRow
    if (song.orders.length === 0) this.ended = true
  }

  private resetChannels(): void {
    this.chans = []
    this.controls.length = 0
    for (let i = 0; i < this.song.channels.length; i++) {
      this.chans.push(new ChState())
      this.controls.push(newChannelControl())
    }
  }

  /** Restart from (order,row) with fresh channel state. */
  reset(order = 0, row = 0): void {
    this.resetChannels()
    this.bpm = this.song.timing.bpm
    this.speed = this.song.timing.speed
    this.grooveOn = true
    this.order = order
    this.row = row
    this.rowLoaded = false
    this.tickInRow = 0
    this.absTick = 0
    this.ended = this.song.orders.length === 0
  }

  /** Hot-swap the song keeping the position and channel state. */
  setSong(song: Song): void {
    const old = this.song
    this.song = song
    this.patterns = resolvePatterns(song)
    if (song.channels.length !== this.chans.length) this.resetChannels()
    if (song.timing.bpm !== old.timing.bpm) this.bpm = song.timing.bpm
    if (song.timing.speed !== old.timing.speed) this.speed = song.timing.speed
    if (song.orders.length === 0) {
      this.ended = true
      return
    }
    this.ended = false
    if (this.order >= song.orders.length) this.order = song.loop ? Math.min(song.loop.order, song.orders.length - 1) : song.orders.length - 1
    if (this.row >= song.patternLength) this.row = song.patternLength - 1
  }

  /** Position of the last produced tick (or the start position before the first tick). */
  position(): SeqPosition {
    return { order: this.order, row: this.row, tick: Math.max(0, this.tickInRow - 1) }
  }

  /** The (order,row) the next tick() will play, or null at the end. */
  upcoming(): { order: number; row: number } | null {
    if (this.ended) return null
    if (!this.rowLoaded || this.tickInRow < this.rowTicks) return { order: this.order, row: this.row }
    const n = nextPosition(this.song, this.order, this.row, this.flow, this.next)
    return n.end ? null : { order: n.order, row: n.row }
  }

  /**
   * Fast-forward (without audio) so that the next tick() starts (order,row). The state of the channels
   * (instruments, volumes, sticky effects) is what playing from the start would give. If the row is never
   * reached the sequencer simply starts there with fresh state.
   */
  seek(order: number, row: number, maxTicks = 2_000_000): void {
    this.reset(0, 0)
    if (order === 0 && row === 0) return
    for (let i = 0; i < maxTicks; i++) {
      const u = this.upcoming()
      if (!u) break
      if (u.order === order && u.row === row && (!this.rowLoaded || this.tickInRow >= this.rowTicks)) return
      if (!this.tick()) break
    }
    this.reset(order, row)
  }

  /** Samples per tick at the current tempo. */
  samplesPerTick(sampleRate: number): number {
    return samplesPerTick(this.song, this.bpm, sampleRate)
  }

  /** Make every control silent (used at the end of a one-shot song). */
  silence(): void {
    for (const c of this.controls) {
      c.trigger = false
      c.gate = false
      c.release = false
      c.vol = 0
    }
  }

  /** Advance one tick. Returns false (and silences the controls) once the song has ended. */
  tick(): boolean {
    if (this.ended) {
      this.silence()
      return false
    }
    if (!this.rowLoaded) {
      this.loadRow()
    } else if (this.tickInRow >= this.rowTicks) {
      const n = nextPosition(this.song, this.order, this.row, this.flow, this.next)
      if (n.end) {
        this.ended = true
        this.silence()
        return false
      }
      this.order = n.order
      this.row = n.row
      this.loadRow()
    }
    const t = this.tickInRow
    for (let c = 0; c < this.chans.length; c++) this.runChannel(c, t)
    this.tickInRow++
    this.absTick++
    return true
  }

  // -------------------------------------------------------------------------------------------

  private loadRow(): void {
    this.rowLoaded = true
    this.tickInRow = 0
    const pats = this.patterns[this.order] ?? []
    scanRowFlow(pats, this.row, this.flow)
    if (this.flow.speed > 0) {
      this.speed = this.flow.speed
      this.grooveOn = false
    }
    if (this.flow.bpm > 0) this.bpm = this.flow.bpm
    this.rowTicks = rowTicksFor(this.song, this.row, this.speed, this.grooveOn)
    for (let c = 0; c < this.chans.length; c++) {
      const cell = pats[c]?.rows[this.row] ?? null
      this.loadCell(this.chans[c]!, cell)
    }
  }

  private loadCell(ch: ChState, cell: Cell | null): void {
    ch.delay = -1
    ch.cut = -1
    ch.qrDir = 0
    if (!cell) return
    const note = cell.note
    const hasNote = typeof note === 'number'
    const fx = cell.fx
    let portaParam = ch.portaRate * 16
    if (fx) for (const e of fx) if (e.code === '3') portaParam = e.param
    const legato = hasNote && portaParam > 0 && ch.gate
    if (hasNote && !legato) {
      ch.slide = 0
      ch.qrTarget = NaN
      ch.portaTarget = NaN
    }
    if (fx) {
      for (const e of fx) {
        const p = e.param
        switch (e.code) {
          case '0':
            ch.arpX = p >> 4
            ch.arpY = p & 15
            break
          case '1':
            ch.slide = p / 16
            break
          case '2':
            ch.slide = -p / 16
            break
          case '3':
            ch.portaRate = p / 16
            if (p === 0) ch.portaTarget = NaN
            break
          case '4':
            ch.vibSpeed = p >> 4
            ch.vibDepth = p & 15
            break
          case '7':
            ch.tremSpeed = p >> 4
            ch.tremDepth = p & 15
            break
          case 'A':
            ch.volSlide = ((p >> 4) - (p & 15)) / 4
            break
          case 'G':
            ch.delay = p
            break
          case 'S':
            ch.cut = p
            break
          case 'P':
            ch.fine = (p - 128) / 128
            break
          case 'Q':
            ch.qrDir = 1
            ch.qrX = p >> 4
            ch.qrY = p & 15
            break
          case 'R':
            ch.qrDir = -1
            ch.qrX = p >> 4
            ch.qrY = p & 15
            break
          case 'W':
            ch.fxTimbre = p
            break
          case 'X':
            ch.panFx = clamp((p - 128) / 128, -1, 1)
            break
          case 'E':
            ch.echo = p !== 0
            break
          default:
            break
        }
      }
    }
    let delayed = false
    if (note === undefined) {
      if (cell.inst !== undefined) ch.inst = cell.inst
      if (cell.vol !== undefined) ch.volF = cell.vol
    } else if (ch.delay > 0 && ch.delay < this.rowTicks) {
      delayed = true
      ch.dNote = note
      ch.dInst = cell.inst
      ch.dVol = cell.vol
    } else if (ch.delay >= this.rowTicks) {
      ch.delay = -1 // delayed past the end of the row: the note never plays
    } else {
      ch.delay = -1
      this.applyNote(ch, note, cell.inst, cell.vol)
    }
    if (ch.qrDir !== 0 && ch.gate && !delayed) {
      ch.qrTarget = ch.note + ch.qrDir * ch.qrY
      ch.qrRate = (2 * ch.qrX + 1) / 16
    }
  }

  private applyNote(ch: ChState, note: NoteValue, inst: number | undefined, vol: number | undefined): void {
    if (inst !== undefined) ch.inst = inst
    if (vol !== undefined) ch.volF = vol
    if (typeof note === 'number') {
      if (ch.portaRate > 0 && ch.gate) {
        ch.portaTarget = note
      } else {
        this.trigger(ch, note)
      }
    } else if (note === 'off') {
      ch.gate = false
      ch.released = false
      ch.volTail = false
    } else {
      this.release(ch)
    }
  }

  private trigger(ch: ChState, note: number): void {
    ch.note = note
    ch.cur = note
    ch.gate = true
    ch.released = false
    ch.volTail = false
    ch.trigger = true
    ch.mVol = 0
    ch.mArp = 0
    ch.mPitch = 0
    ch.mTim = 0
    ch.pitchAcc = 0
    ch.vibPhase = 0
    ch.tremPhase = 0
    ch.portaTarget = NaN
  }

  private release(ch: ChState): void {
    if (!ch.gate && !ch.volTail) return
    ch.gate = false
    ch.released = true
    const m = macrosOf(this.song.instruments[ch.inst])
    const v = m?.vol
    if (v && v.release !== undefined && v.release < v.values.length) {
      ch.volTail = true
      ch.mVol = v.release
    } else ch.volTail = false
    if (m?.arp?.release !== undefined && m.arp.release < m.arp.values.length) ch.mArp = m.arp.release
    if (m?.pitch?.release !== undefined && m.pitch.release < m.pitch.values.length) ch.mPitch = m.pitch.release
    if (m?.timbre?.release !== undefined && m.timbre.release < m.timbre.values.length) ch.mTim = m.timbre.release
  }

  private runChannel(c: number, t: number): void {
    const ch = this.chans[c]!
    const ctl = this.controls[c]!
    const song = this.song

    if (ch.delay === t && ch.dNote !== undefined) {
      this.applyNote(ch, ch.dNote, ch.dInst, ch.dVol)
      ch.dNote = undefined
      ch.delay = -1
      if (ch.qrDir !== 0 && ch.gate) {
        ch.qrTarget = ch.note + ch.qrDir * ch.qrY
        ch.qrRate = (2 * ch.qrX + 1) / 16
      }
    }
    if (ch.cut === t) {
      ch.gate = false
      ch.released = false
      ch.volTail = false
      ch.cut = -1
    }

    if (t > 0 && ch.gate) {
      if (ch.slide !== 0) ch.cur += ch.slide
      if (!Number.isNaN(ch.portaTarget)) {
        const d = ch.portaTarget - ch.cur
        if (Math.abs(d) <= ch.portaRate) {
          ch.cur = ch.portaTarget
          ch.note = ch.portaTarget
          ch.portaTarget = NaN
        } else ch.cur += d > 0 ? ch.portaRate : -ch.portaRate
      }
      if (!Number.isNaN(ch.qrTarget)) {
        const d = ch.qrTarget - ch.cur
        if (Math.abs(d) <= ch.qrRate) {
          ch.cur = ch.qrTarget
          ch.note = ch.qrTarget
          ch.qrTarget = NaN
        } else ch.cur += d > 0 ? ch.qrRate : -ch.qrRate
      }
      if (ch.volSlide !== 0) ch.volF = clamp(ch.volF + ch.volSlide, 0, 15)
    }

    const sounding = ch.gate || ch.volTail
    const macros = macrosOf(song.instruments[ch.inst])

    let semis = ch.cur
    let mv = 15
    let timbre = ch.fxTimbre
    let macroTimbre = -1
    if (macros) {
      const vm = macros.vol
      if (vm && vm.values.length > 0) mv = vm.values[Math.min(ch.mVol, vm.values.length - 1)]!
      const am = macros.arp
      if (am && am.values.length > 0) {
        const v = am.values[Math.min(ch.mArp, am.values.length - 1)]!
        semis = am.mode === 'fixed' ? v + (ch.cur - ch.note) : ch.cur + v
      }
      const pm = macros.pitch
      if (pm && pm.values.length > 0 && sounding) {
        ch.pitchAcc = clamp(ch.pitchAcc + pm.values[Math.min(ch.mPitch, pm.values.length - 1)]! / 16, -48, 48)
      }
      const tm = macros.timbre
      if (tm && tm.values.length > 0) macroTimbre = tm.values[Math.min(ch.mTim, tm.values.length - 1)]!
    }
    if (timbre < 0) timbre = macroTimbre
    semis += ch.pitchAcc

    if (ch.arpX !== 0 || ch.arpY !== 0) {
      const k = t % 3
      semis += k === 1 ? ch.arpX : k === 2 ? ch.arpY : 0
    }
    if (ch.vibDepth !== 0) semis += (Math.sin((2 * Math.PI * ch.vibPhase) / 64) * ch.vibDepth) / 16
    semis += ch.fine
    semis = clamp(semis, 0, 135)

    let trem = 1
    if (ch.tremDepth !== 0) trem = 1 - (ch.tremDepth / 16) * (0.5 + 0.5 * Math.sin((2 * Math.PI * ch.tremPhase) / 64))
    const rawVol = clamp(ch.volF / 15, 0, 1)
    const vol = sounding ? clamp(rawVol * (mv / 15) * trem, 0, 1) : 0

    ctl.trigger = ch.trigger
    ctl.gate = ch.gate
    ctl.release = ch.released
    ctl.semis = semis
    ctl.freqHz = midiToHz(semis)
    ctl.vol = vol
    ctl.rawVol = rawVol
    ctl.timbre = timbre
    ctl.pan = Number.isNaN(ch.panFx) ? (song.channels[c]?.pan ?? 0) : ch.panFx
    ctl.inst = ch.inst
    ctl.note = ch.note
    if (ch.echo !== undefined) ctl.echo = ch.echo
    ch.trigger = false

    // advance per-tick state
    ch.vibPhase = (ch.vibPhase + ch.vibSpeed) % 64
    ch.tremPhase = (ch.tremPhase + ch.tremSpeed) % 64
    if (sounding && macros) {
      const rel = ch.released
      if (macros.vol && (ch.gate || ch.volTail)) ch.mVol = nextMacroPos(macros.vol, ch.mVol, rel)
      if (macros.arp) ch.mArp = nextMacroPos(macros.arp, ch.mArp, rel)
      if (macros.pitch) ch.mPitch = nextMacroPos(macros.pitch, ch.mPitch, rel)
      if (macros.timbre) ch.mTim = nextMacroPos(macros.timbre, ch.mTim, rel)
    }
  }
}
