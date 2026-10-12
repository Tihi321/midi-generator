// Standard MIDI File (SMF) primitives: an event model, a writer (type 1) and a tolerant reader (types 0/1/2).
// Pure TypeScript, no DOM, no node:*. The song <-> MIDI logic lives in midi.ts / midiImport.ts.

export const MIDI_PPQ = 480

export type MidiEvent =
  | { tick: number; kind: 'noteOn'; channel: number; note: number; velocity: number }
  | { tick: number; kind: 'noteOff'; channel: number; note: number; velocity: number }
  | { tick: number; kind: 'cc'; channel: number; controller: number; value: number }
  | { tick: number; kind: 'pitchBend'; channel: number; /** 0..16383, 8192 = centre */ value: number }
  | { tick: number; kind: 'program'; channel: number; program: number }
  | { tick: number; kind: 'meta'; type: number; data: Uint8Array }

export interface ParsedMidi {
  format: number
  division: number
  /** Events of each track in file order, with absolute ticks. */
  tracks: MidiEvent[][]
  warnings: string[]
}

// ---------------------------------------------------------------- meta helpers

export const META_TRACK_NAME = 0x03
export const META_MARKER = 0x06
export const META_END_OF_TRACK = 0x2f
export const META_TEMPO = 0x51
export const META_TIME_SIGNATURE = 0x58
export const META_KEY_SIGNATURE = 0x59

export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    out[i] = c < 128 && c >= 32 ? c : 63 // '?'
  }
  return out
}

export function metaText(tick: number, type: number, text: string): MidiEvent {
  return { tick, kind: 'meta', type, data: ascii(text) }
}

export function metaTempo(tick: number, microsPerQuarter: number): MidiEvent {
  const us = Math.max(1, Math.min(0xffffff, Math.round(microsPerQuarter)))
  return { tick, kind: 'meta', type: META_TEMPO, data: Uint8Array.of((us >> 16) & 255, (us >> 8) & 255, us & 255) }
}

export function metaTimeSignature(tick: number, numerator: number, denominatorPower: number): MidiEvent {
  return { tick, kind: 'meta', type: META_TIME_SIGNATURE, data: Uint8Array.of(numerator & 255, denominatorPower & 255, 24, 8) }
}

export function metaKeySignature(tick: number, sharps: number, minor: boolean): MidiEvent {
  return { tick, kind: 'meta', type: META_KEY_SIGNATURE, data: Uint8Array.of(sharps & 255, minor ? 1 : 0) }
}

export function metaString(ev: MidiEvent): string {
  if (ev.kind !== 'meta') return ''
  let s = ''
  for (const b of ev.data) s += String.fromCharCode(b)
  return s
}

// ---------------------------------------------------------------- writer

class ByteWriter {
  private buf = new Uint8Array(1024)
  length = 0
  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return
    let cap = this.buf.length
    while (cap < this.length + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }
  byte(b: number): void {
    this.ensure(1)
    this.buf[this.length++] = b & 255
  }
  bytes(b: ArrayLike<number>): void {
    this.ensure(b.length)
    for (let i = 0; i < b.length; i++) this.buf[this.length++] = b[i]! & 255
  }
  vlq(value: number): void {
    let v = Math.max(0, Math.floor(value))
    const stack = [v & 0x7f]
    v = Math.floor(v / 128)
    while (v > 0) {
      stack.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    for (let i = stack.length - 1; i >= 0; i--) this.byte(stack[i]!)
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length)
  }
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
}

function encodeTrack(events: readonly MidiEvent[]): Uint8Array {
  const w = new ByteWriter()
  let tick = 0
  let lastStatus = -1
  let endTick = 0
  for (const ev of events) {
    if (ev.kind === 'meta' && ev.type === META_END_OF_TRACK) {
      endTick = Math.max(endTick, ev.tick)
      continue
    }
    const t = Math.max(tick, Math.round(ev.tick))
    w.vlq(t - tick)
    tick = t
    switch (ev.kind) {
      case 'meta':
        w.byte(0xff)
        w.byte(ev.type)
        w.vlq(ev.data.length)
        w.bytes(ev.data)
        lastStatus = -1
        break
      case 'noteOn':
      case 'noteOff':
      case 'cc':
      case 'pitchBend':
      case 'program': {
        let status: number
        let d1: number
        let d2: number | undefined
        if (ev.kind === 'noteOn') [status, d1, d2] = [0x90 | ev.channel, ev.note, ev.velocity]
        else if (ev.kind === 'noteOff') [status, d1, d2] = [0x80 | ev.channel, ev.note, ev.velocity]
        else if (ev.kind === 'cc') [status, d1, d2] = [0xb0 | ev.channel, ev.controller, ev.value]
        else if (ev.kind === 'pitchBend') [status, d1, d2] = [0xe0 | ev.channel, ev.value & 0x7f, (ev.value >> 7) & 0x7f]
        else [status, d1, d2] = [0xc0 | ev.channel, ev.program, undefined]
        if (status !== lastStatus) w.byte(status)
        lastStatus = status
        w.byte(d1 & 0x7f)
        if (d2 !== undefined) w.byte(d2 & 0x7f)
        break
      }
    }
  }
  w.vlq(Math.max(0, Math.round(endTick) - tick))
  w.bytes([0xff, META_END_OF_TRACK, 0])
  return w.result()
}

/** Encode a type-1 SMF. Each track's events must already be sorted by tick (the order within a tick is kept). */
export function encodeSmf(tracks: readonly (readonly MidiEvent[])[], division = MIDI_PPQ): Uint8Array {
  const chunks: Uint8Array[] = []
  const head = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (division >> 8) & 255, division & 255])
  chunks.push(head)
  for (const t of tracks) {
    const body = encodeTrack(t)
    chunks.push(Uint8Array.from([0x4d, 0x54, 0x72, 0x6b, ...u32(body.length)]), body)
  }
  const total = chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

// ---------------------------------------------------------------- reader

export class MidiParseError extends Error {}

/** Parse an SMF (format 0, 1 or 2). Handles running status, meta events and sysex (skipped). Truncated data is tolerated with a warning. */
export function parseSmf(bytes: Uint8Array): ParsedMidi {
  const warnings: string[] = []
  const tag = (o: number): string => String.fromCharCode(bytes[o] ?? 0, bytes[o + 1] ?? 0, bytes[o + 2] ?? 0, bytes[o + 3] ?? 0)
  const be32 = (o: number): number => (((bytes[o] ?? 0) << 24) | ((bytes[o + 1] ?? 0) << 16) | ((bytes[o + 2] ?? 0) << 8) | (bytes[o + 3] ?? 0)) >>> 0
  if (bytes.length < 14 || tag(0) !== 'MThd') {
    // RIFF-wrapped MIDI (RMID): look for the SMF inside
    if (bytes.length > 20 && tag(0) === 'RIFF' && tag(8) === 'RMID') {
      for (let o = 12; o + 8 <= bytes.length; ) {
        const len = (bytes[o + 4] ?? 0) | ((bytes[o + 5] ?? 0) << 8) | ((bytes[o + 6] ?? 0) << 16) | ((bytes[o + 7] ?? 0) << 24)
        if (tag(o) === 'data') return parseSmf(bytes.subarray(o + 8, o + 8 + len))
        o += 8 + len + (len & 1)
      }
    }
    throw new MidiParseError('Not a MIDI file: the data does not start with an "MThd" header. Use a Standard MIDI File (.mid, format 0 or 1).')
  }
  const headLen = be32(4)
  const format = ((bytes[8] ?? 0) << 8) | (bytes[9] ?? 0)
  const trackCount = ((bytes[10] ?? 0) << 8) | (bytes[11] ?? 0)
  const division = ((bytes[12] ?? 0) << 8) | (bytes[13] ?? 0)
  if (division & 0x8000) throw new MidiParseError('This MIDI file uses SMPTE time division, which is not supported. Re-save it with ticks per quarter note (PPQ).')
  if (division === 0) throw new MidiParseError('Invalid MIDI file: ticks per quarter note is 0.')
  if (format > 2) warnings.push(`Unknown MIDI format ${format}; reading it as format 1.`)
  const tracks: MidiEvent[][] = []
  let pos = 8 + Math.max(6, headLen)
  while (pos + 8 <= bytes.length && tracks.length < Math.max(trackCount, 1) + 64) {
    const id = tag(pos)
    const len = be32(pos + 4)
    const start = pos + 8
    const end = Math.min(bytes.length, start + len)
    if (end < start + len) warnings.push(`Track ${tracks.length} is truncated; reading what is there.`)
    if (id === 'MTrk') tracks.push(readTrack(bytes, start, end, warnings, tracks.length))
    pos = start + len
  }
  if (tracks.length === 0) throw new MidiParseError('The MIDI file has no tracks.')
  return { format, division, tracks, warnings }
}

function readTrack(bytes: Uint8Array, start: number, end: number, warnings: string[], index: number): MidiEvent[] {
  const events: MidiEvent[] = []
  let p = start
  let tick = 0
  let running = -1
  const vlq = (): number => {
    let v = 0
    for (let i = 0; i < 5 && p < end; i++) {
      const b = bytes[p++]!
      v = v * 128 + (b & 0x7f)
      if (!(b & 0x80)) break
    }
    return v
  }
  while (p < end) {
    tick += vlq()
    if (p >= end) break
    let status = bytes[p]!
    if (status < 0x80) {
      if (running < 0) {
        warnings.push(`Track ${index}: data byte without a status; track skipped after this point.`)
        break
      }
      status = running
    } else {
      p++
      if (status < 0xf0) running = status
    }
    if (status === 0xff) {
      const type = bytes[p++] ?? 0
      const len = vlq()
      events.push({ tick, kind: 'meta', type, data: bytes.slice(p, Math.min(end, p + len)) })
      p += len
      running = -1
      if (type === META_END_OF_TRACK) break
    } else if (status === 0xf0 || status === 0xf7) {
      const len = vlq()
      p += len
      running = -1
    } else if (status >= 0xf1) {
      // system common/realtime: single-byte or short messages, not expected in files
      if (status === 0xf2) p += 2
      else if (status === 0xf1 || status === 0xf3) p += 1
    } else {
      const type = status & 0xf0
      const channel = status & 0x0f
      const d1 = bytes[p++] ?? 0
      if (type === 0xc0) events.push({ tick, kind: 'program', channel, program: d1 & 0x7f })
      else if (type === 0xd0) {
        /* channel pressure: ignored */
      } else {
        const d2 = bytes[p++] ?? 0
        if (type === 0x90) events.push(d2 === 0 ? { tick, kind: 'noteOff', channel, note: d1, velocity: 0 } : { tick, kind: 'noteOn', channel, note: d1, velocity: d2 })
        else if (type === 0x80) events.push({ tick, kind: 'noteOff', channel, note: d1, velocity: d2 })
        else if (type === 0xb0) events.push({ tick, kind: 'cc', channel, controller: d1, value: d2 })
        else if (type === 0xe0) events.push({ tick, kind: 'pitchBend', channel, value: (d1 & 0x7f) | ((d2 & 0x7f) << 7) })
        // 0xa0 polyphonic aftertouch: ignored
      }
    }
  }
  return events
}
