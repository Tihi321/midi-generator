// Generates the app icon from a 16x16 pixel-art grid (a beamed pair of eighth notes on a dark tile):
//   build/icon.png = 512x512 (window icon, electron-builder fallback)
//   build/icon.ico = 16..256 px PNG entries (Windows exe / installer / shortcuts)
// Run: yarn gen:icon

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

// . transparent, B tile, E tile edge, N note, H note highlight, S note shadow
const GRID = [
  '.EEEEEEEEEEEEEE.',
  'EBBBBBBBBBBBBBBE',
  'EBBBBBBBBBBBBBBE',
  'EBBBBBHNNNNNNNBE',
  'EBBBBBNNNNNNNSBE',
  'EBBBBBNBBBBBBSBE',
  'EBBBBBNBBBBBBSBE',
  'EBBBBBNBBBBBBSBE',
  'EBBBBBNBBBBBBSBE',
  'EBBBBBNBBBBBBSBE',
  'EBBHNNNBBBHNNSBE',
  'EBHNNNNBBHNNNSBE',
  'EBNNNNSBBNNNNSBE',
  'EBBSSSBBBBSSSBBE',
  'EBBBBBBBBBBBBBBE',
  '.EEEEEEEEEEEEEE.'
]

const COLORS = {
  '.': [0, 0, 0, 0],
  B: [0x1c, 0x1f, 0x27, 255],
  E: [0x2a, 0x2e, 0x39, 255],
  N: [0x4f, 0x8c, 0xff, 255],
  H: [0x9d, 0xc0, 0xff, 255],
  S: [0x2f, 0x5f, 0xc0, 255]
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** The grid scaled up (nearest neighbour) to `size` px as an RGBA PNG. `size` must be a multiple of 16. */
export function renderPng(size) {
  const scale = size / GRID.length
  if (!Number.isInteger(scale)) throw new Error(`Icon size ${size} is not a multiple of ${GRID.length}.`)
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const rgba = COLORS[GRID[Math.floor(y / scale)][Math.floor(x / scale)]]
      raw.set(rgba, row + 1 + x * 4)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** An .ico file holding one PNG entry per size. */
export function renderIco(sizes) {
  const images = sizes.map(renderPng)
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i
    header[e] = size >= 256 ? 0 : size
    header[e + 1] = size >= 256 ? 0 : size
    header.writeUInt16LE(1, e + 4) // planes
    header.writeUInt16LE(32, e + 6) // bits per pixel
    header.writeUInt32LE(images[i].length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += images[i].length
  })
  return Buffer.concat([header, ...images])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const out = resolve(root, 'build')
  mkdirSync(out, { recursive: true })
  writeFileSync(resolve(out, 'icon.png'), renderPng(512))
  writeFileSync(resolve(out, 'icon.ico'), renderIco([16, 32, 48, 64, 128, 256]))
  console.log('Wrote build/icon.png and build/icon.ico')
}
