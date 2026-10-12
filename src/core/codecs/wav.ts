// RIFF/WAVE reader and writer (PCM16 output, optional `smpl` loop chunk and LIST/INFO). Pure TypeScript on
// Uint8Array / DataView: no Buffer, no node APIs.

export interface WavLoop {
  /** First loop sample (inclusive). */
  start: number
  /** Last loop sample, INCLUSIVE (the smpl chunk convention). */
  end: number
  /** 0 = forward. */
  type: number
  playCount: number
}

export interface WriteWavOptions {
  sampleRate: number
  /** One array per channel (1 = mono, 2 = stereo). Int16 is written as is; Float32 (-1..1) is rounded and clamped. */
  channels: ReadonlyArray<Int16Array | Float32Array>
  /** Forward loop: start inclusive, end EXCLUSIVE (written to the file as end - 1). */
  loop?: { start: number; end: number }
  /** INFO/INAM */
  title?: string
  /** INFO/ISFT */
  software?: string
}

export interface ParsedWav {
  sampleRate: number
  numChannels: number
  bitsPerSample: number
  /** Frames per channel. */
  length: number
  /** Samples normalised to -1..1, one array per channel. */
  channels: Float32Array[]
  /** Raw 16-bit samples per channel when the file is PCM16. */
  int16?: Int16Array[]
  loops: WavLoop[]
  /** smpl: sample period in nanoseconds and MIDI unity note (when a smpl chunk exists). */
  samplePeriod?: number
  midiUnityNote?: number
  /** LIST/INFO entries by 4-char id (INAM, ISFT, ...). */
  info: Record<string, string>
}

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8')

function toInt16(v: number): number {
  const r = Math.round(v * 32767)
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r
}

export function writeWav(opts: WriteWavOptions): Uint8Array {
  const nch = opts.channels.length
  if (nch < 1) throw new Error('writeWav: at least one channel is required')
  const frames = opts.channels[0]!.length
  for (const c of opts.channels) if (c.length !== frames) throw new Error('writeWav: channels must have equal length')
  const sr = opts.sampleRate

  const dataBytes = frames * nch * 2
  const fmtSize = 8 + 16
  const dataSize = 8 + dataBytes + (dataBytes & 1)

  let smplSize = 0
  if (opts.loop) smplSize = 8 + 36 + 24
  const infoEntries: [string, Uint8Array][] = []
  if (opts.title !== undefined) infoEntries.push(['INAM', enc.encode(opts.title + '\0')])
  if (opts.software !== undefined) infoEntries.push(['ISFT', enc.encode(opts.software + '\0')])
  let listSize = 0
  if (infoEntries.length > 0) {
    listSize = 8 + 4
    for (const [, v] of infoEntries) listSize += 8 + v.length + (v.length & 1)
  }

  const total = 12 + fmtSize + dataSize + smplSize + listSize
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  let p = 0
  const tag = (s: string): void => {
    for (let i = 0; i < 4; i++) out[p + i] = s.charCodeAt(i)
    p += 4
  }
  const u32 = (v: number): void => {
    dv.setUint32(p, v >>> 0, true)
    p += 4
  }
  const u16 = (v: number): void => {
    dv.setUint16(p, v & 0xffff, true)
    p += 2
  }

  tag('RIFF')
  u32(total - 8)
  tag('WAVE')

  tag('fmt ')
  u32(16)
  u16(1)
  u16(nch)
  u32(sr)
  u32(sr * nch * 2)
  u16(nch * 2)
  u16(16)

  tag('data')
  u32(dataBytes)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const src = opts.channels[c]!
      const v = src instanceof Int16Array ? src[i]! : toInt16(src[i]!)
      dv.setInt16(p, v, true)
      p += 2
    }
  }
  if (dataBytes & 1) p += 1

  if (opts.loop) {
    tag('smpl')
    u32(36 + 24)
    u32(0) // manufacturer
    u32(0) // product
    u32(Math.round(1e9 / sr)) // sample period (ns)
    u32(60) // MIDI unity note
    u32(0) // pitch fraction
    u32(0) // SMPTE format
    u32(0) // SMPTE offset
    u32(1) // loops
    u32(0) // sampler data
    u32(0) // cue point id
    u32(0) // type: forward
    u32(opts.loop.start)
    u32(opts.loop.end - 1)
    u32(0) // fraction
    u32(0) // play count: infinite
  }

  if (infoEntries.length > 0) {
    tag('LIST')
    u32(listSize - 8)
    tag('INFO')
    for (const [id, v] of infoEntries) {
      tag(id)
      u32(v.length)
      out.set(v, p)
      p += v.length + (v.length & 1)
    }
  }
  return out
}

export function readWav(bytes: Uint8Array): ParsedWav {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const str = (o: number): string => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!)
  if (bytes.length < 12 || str(0) !== 'RIFF' || str(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file')

  let format = 0
  let nch = 0
  let sr = 0
  let bits = 0
  let dataOff = -1
  let dataLen = 0
  const loops: WavLoop[] = []
  const info: Record<string, string> = {}
  let samplePeriod: number | undefined
  let midiUnityNote: number | undefined

  let p = 12
  while (p + 8 <= bytes.length) {
    const id = str(p)
    let size = dv.getUint32(p + 4, true)
    const body = p + 8
    if (body + size > bytes.length) size = bytes.length - body
    if (id === 'fmt ') {
      format = dv.getUint16(body, true)
      nch = dv.getUint16(body + 2, true)
      sr = dv.getUint32(body + 4, true)
      bits = dv.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true)
    } else if (id === 'data') {
      dataOff = body
      dataLen = size
    } else if (id === 'smpl' && size >= 36) {
      samplePeriod = dv.getUint32(body + 8, true)
      midiUnityNote = dv.getUint32(body + 12, true)
      const n = dv.getUint32(body + 28, true)
      for (let i = 0; i < n; i++) {
        const o = body + 36 + i * 24
        if (o + 24 > body + size) break
        loops.push({ type: dv.getUint32(o + 4, true), start: dv.getUint32(o + 8, true), end: dv.getUint32(o + 12, true), playCount: dv.getUint32(o + 20, true) })
      }
    } else if (id === 'LIST' && size >= 4 && str(body) === 'INFO') {
      let q = body + 4
      while (q + 8 <= body + size) {
        const sid = str(q)
        const ssz = dv.getUint32(q + 4, true)
        const raw = bytes.subarray(q + 8, Math.min(q + 8 + ssz, body + size))
        let end = raw.length
        while (end > 0 && raw[end - 1] === 0) end--
        info[sid] = dec.decode(raw.subarray(0, end))
        q += 8 + ssz + (ssz & 1)
      }
    }
    p = body + size + (size & 1)
  }

  if (nch < 1 || dataOff < 0) throw new Error('WAV file has no fmt or data chunk')
  const bytesPer = bits / 8
  if (format !== 1 && format !== 3) throw new Error(`Unsupported WAV format tag ${format} (PCM or float only)`)
  if (!(bits === 8 || bits === 16 || bits === 24 || bits === 32)) throw new Error(`Unsupported WAV bit depth ${bits}`)
  const frames = Math.floor(dataLen / (bytesPer * nch))
  const channels: Float32Array[] = []
  const int16: Int16Array[] = []
  for (let c = 0; c < nch; c++) {
    channels.push(new Float32Array(frames))
    if (bits === 16 && format === 1) int16.push(new Int16Array(frames))
  }
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const o = dataOff + (i * nch + c) * bytesPer
      let v: number
      if (format === 3) {
        v = bits === 32 ? dv.getFloat32(o, true) : 0
      } else if (bits === 16) {
        const s = dv.getInt16(o, true)
        int16[c]![i] = s
        v = s / 32768
      } else if (bits === 8) {
        v = (bytes[o]! - 128) / 128
      } else if (bits === 24) {
        let s = bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16)
        if (s & 0x800000) s |= ~0xffffff
        v = s / 8388608
      } else {
        v = dv.getInt32(o, true) / 2147483648
      }
      channels[c]![i] = v
    }
  }
  const res: ParsedWav = { sampleRate: sr, numChannels: nch, bitsPerSample: bits, length: frames, channels, loops, info }
  if (int16.length > 0) res.int16 = int16
  if (samplePeriod !== undefined) res.samplePeriod = samplePeriod
  if (midiUnityNote !== undefined) res.midiUnityNote = midiUnityNote
  return res
}
