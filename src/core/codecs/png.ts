// Pure TypeScript PNG encoder/decoder (zlib via fflate) and base64 helpers. No Buffer, no DOM.

import { unzlibSync, zlibSync } from 'fflate'

export interface RgbaImage {
  width: number
  height: number
  /** Packed 0xAABBGGRR pixels, row-major. */
  data: Uint32Array
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b)
}

// ---------------------------------------------------------------- CRC / chunks

let crcTable: Uint32Array | null = null
function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]!) & 255]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u32(v: number): number[] {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  out.set(u32(data.length), 0)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  out.set(u32(crc32(out, 4, 8 + data.length)), 8 + data.length)
  return out
}

// ---------------------------------------------------------------- scaling

/** Nearest-neighbour integer upscale. */
export function scaleImage(img: RgbaImage, scale: number): RgbaImage {
  const s = Math.max(1, Math.floor(scale))
  if (s === 1) return img
  const w = img.width * s
  const h = img.height * s
  const data = new Uint32Array(w * h)
  for (let y = 0; y < img.height; y++) {
    const rowStart = y * s * w
    for (let x = 0; x < img.width; x++) {
      const c = img.data[y * img.width + x]!
      for (let k = 0; k < s; k++) data[rowStart + x * s + k] = c
    }
    for (let k = 1; k < s; k++) data.copyWithin(rowStart + k * w, rowStart, rowStart + w)
  }
  return { width: w, height: h, data }
}

// ---------------------------------------------------------------- encode

export interface EncodePngOptions {
  /** Nearest-neighbour upscale factor (default 1). */
  scale?: number
  /** zlib compression level 0-9 (default 6). */
  level?: number
}

/** Encode packed RGBA pixels as an 8-bit RGBA PNG. */
export function encodePng(image: RgbaImage, opts: EncodePngOptions = {}): Uint8Array {
  const img = scaleImage(image, opts.scale ?? 1)
  const { width, height, data } = img
  if (data.length !== width * height) throw new Error('PNG encode: pixel buffer size does not match width*height.')
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    let o = y * (stride + 1)
    raw[o++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const c = data[y * width + x]!
      raw[o++] = c & 255
      raw[o++] = (c >>> 8) & 255
      raw[o++] = (c >>> 16) & 255
      raw[o++] = c >>> 24
    }
  }
  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0])
  const idat = zlibSync(raw, { level: (opts.level ?? 6) as 6 })
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// ---------------------------------------------------------------- decode

function readU32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
}

/** Decode a non-interlaced, 8-bit (or palette 1/2/4/8-bit) PNG: color types 0, 2, 3, 4, 6. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!hasPngSignature(bytes)) throw new Error('Not a PNG file (bad signature).')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = -1
  let interlace = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []
  while (pos + 8 <= bytes.length) {
    const len = readU32(bytes, pos)
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!)
    const body = bytes.subarray(pos + 8, pos + 8 + len)
    if (body.length < len) throw new Error('PNG is truncated.')
    pos += 12 + len
    if (type === 'IHDR') {
      width = readU32(body, 0)
      height = readU32(body, 4)
      bitDepth = body[8]!
      colorType = body[9]!
      interlace = body[12]!
    } else if (type === 'PLTE') palette = body.slice()
    else if (type === 'tRNS') trns = body.slice()
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
  }
  if (width < 1 || height < 1) throw new Error('PNG has no IHDR chunk or zero size.')
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported. Re-save the PNG without interlacing.')
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}.`)
  if (colorType === 3 ? ![1, 2, 4, 8].includes(bitDepth) : bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth} for color type ${colorType} (only 8-bit, or 1/2/4/8-bit palette images).`)
  }
  if (colorType === 3 && !palette) throw new Error('Indexed PNG is missing its PLTE chunk.')

  const total = idat.reduce((n, p) => n + p.length, 0)
  const joined = new Uint8Array(total)
  let o = 0
  for (const p of idat) {
    joined.set(p, o)
    o += p.length
  }
  const raw = unzlibSync(joined)
  const bitsPerPixel = channels * bitDepth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  if (raw.length < (stride + 1) * height) throw new Error('PNG pixel data is truncated.')

  const cur = new Uint8Array(stride)
  let prev = new Uint8Array(stride)
  const out = new Uint32Array(width * height)
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1)
    const ft = raw[base]!
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i]!
      const a = i >= bpp ? cur[i - bpp]! : 0
      const b = prev[i]!
      const c = i >= bpp ? prev[i - bpp]! : 0
      let v: number
      switch (ft) {
        case 0:
          v = x
          break
        case 1:
          v = x + a
          break
        case 2:
          v = x + b
          break
        case 3:
          v = x + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`PNG row ${y} has unknown filter type ${ft}.`)
      }
      cur[i] = v & 255
    }
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 255
      switch (colorType) {
        case 6:
          r = cur[x * 4]!
          g = cur[x * 4 + 1]!
          b = cur[x * 4 + 2]!
          a = cur[x * 4 + 3]!
          break
        case 2:
          r = cur[x * 3]!
          g = cur[x * 3 + 1]!
          b = cur[x * 3 + 2]!
          if (trns && trns.length >= 6 && trns[1] === r && trns[3] === g && trns[5] === b) a = 0
          break
        case 0:
          r = g = b = cur[x]!
          if (trns && trns.length >= 2 && trns[1] === r) a = 0
          break
        case 4:
          r = g = b = cur[x * 2]!
          a = cur[x * 2 + 1]!
          break
        case 3: {
          let idx: number
          if (bitDepth === 8) idx = cur[x]!
          else {
            const bitPos = x * bitDepth
            const byte = cur[bitPos >> 3]!
            const shift = 8 - bitDepth - (bitPos & 7)
            idx = (byte >> shift) & ((1 << bitDepth) - 1)
          }
          r = palette![idx * 3] ?? 0
          g = palette![idx * 3 + 1] ?? 0
          b = palette![idx * 3 + 2] ?? 0
          a = trns && idx < trns.length ? trns[idx]! : 255
          break
        }
      }
      out[y * width + x] = a === 0 ? 0 : ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
    }
    prev = Uint8Array.from(cur)
  }
  return { width, height, data: out }
}

// ---------------------------------------------------------------- base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
let b64Lookup: Int16Array | null = null

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const n = bytes.length
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < n ? bytes[i + 1]! : 0
    const b2 = i + 2 < n ? bytes[i + 2]! : 0
    out += B64[b0 >> 2]! + B64[((b0 & 3) << 4) | (b1 >> 4)]!
    out += i + 1 < n ? B64[((b1 & 15) << 2) | (b2 >> 6)]! : '='
    out += i + 2 < n ? B64[b2 & 63]! : '='
  }
  return out
}

export function base64ToBytes(text: string): Uint8Array {
  if (!b64Lookup) {
    b64Lookup = new Int16Array(256).fill(-1)
    for (let i = 0; i < B64.length; i++) b64Lookup[B64.charCodeAt(i)] = i
    b64Lookup['-'.charCodeAt(0)] = 62
    b64Lookup['_'.charCodeAt(0)] = 63
  }
  const clean = text.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
  const stripped = clean.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((stripped.length * 3) / 4))
  let buf = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < stripped.length; i++) {
    const v = b64Lookup[stripped.charCodeAt(i)]!
    if (v < 0) throw new Error(`Invalid base64 character at position ${i}.`)
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buf >> bits) & 255
    }
  }
  return out.subarray(0, o)
}
