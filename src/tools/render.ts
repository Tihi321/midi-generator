// Piano-roll preview used by render_preview: the song (or a few order rows) as a PNG image, one colour per
// channel, with a bar/beat grid, octave labels and drum lanes. Pure TS (no DOM): pixels are packed
// 0xAABBGGRR like core/codecs/png.

import { type Song, bytesToBase64, buildNoteTimeline, encodePng, rowsPerBar, songChannelDefs } from '../core'

export interface PianoRollOptions {
  /** First order row shown (default 0). */
  fromOrder?: number
  /** Last order row shown, inclusive (default: the last that fits). */
  toOrder?: number
  /** Channel ids to show (default: all). */
  channels?: string[]
  /** Shade the notes a single shown channel cannot play on its chip. */
  chipRange?: boolean
  /** Maximum image width in pixels (default 1200). */
  maxWidth?: number
}

export interface PianoRollResult {
  png: Uint8Array
  base64: string
  width: number
  height: number
  fromOrder: number
  toOrder: number
  rows: number
  pxPerRow: number
  pxPerSemitone: number
  /** Lowest/highest MIDI note drawn (melodic channels). */
  low: number
  high: number
  legend: { channel: string; color: string; notes: number; drums: number }[]
  /** True when the requested order range did not fit and was cut. */
  truncated: boolean
}

const PALETTE: { name: string; rgb: [number, number, number] }[] = [
  { name: 'red', rgb: [230, 80, 80] },
  { name: 'orange', rgb: [240, 160, 60] },
  { name: 'yellow', rgb: [235, 215, 70] },
  { name: 'green', rgb: [90, 200, 100] },
  { name: 'cyan', rgb: [70, 205, 215] },
  { name: 'blue', rgb: [80, 130, 240] },
  { name: 'purple', rgb: [165, 110, 235] },
  { name: 'pink', rgb: [235, 120, 190] }
]

const GLYPHS: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001001001',
  '8': '111101111101111',
  '9': '111101111001111'
}

const pack = (r: number, g: number, b: number, a = 255): number => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0

function mix(c: [number, number, number], bg: [number, number, number], t: number): [number, number, number] {
  return [Math.round(bg[0] + (c[0] - bg[0]) * t), Math.round(bg[1] + (c[1] - bg[1]) * t), Math.round(bg[2] + (c[2] - bg[2]) * t)]
}

const BG: [number, number, number] = [20, 22, 28]

export function renderPianoRoll(song: Song, opts: PianoRollOptions = {}): PianoRollResult {
  const tl = buildNoteTimeline(song)
  const maxWidth = opts.maxWidth ?? 1200
  const LEFT = 22
  const TOP = 10
  const pl = song.patternLength
  const fromOrder = Math.max(0, Math.min(song.orders.length - 1, opts.fromOrder ?? 0))
  const wantTo = Math.max(fromOrder, Math.min(song.orders.length - 1, opts.toOrder ?? song.orders.length - 1))
  const fit = Math.max(1, Math.floor((maxWidth - LEFT) / 2 / pl))
  const toOrder = Math.min(wantTo, fromOrder + fit - 1)
  const truncated = toOrder < wantTo
  const rows = (toOrder - fromOrder + 1) * pl
  const row0 = fromOrder * pl
  const pxRow = Math.max(2, Math.min(16, Math.floor((maxWidth - LEFT) / rows)))

  const shown = new Set(opts.channels ?? song.channels.map((c) => c.id))
  const chans = song.channels.map((c, i) => ({ c, i })).filter(({ c }) => shown.has(c.id))

  // pitch range over the shown melodic rows (including arpeggio tones)
  let lo = 127
  let hi = 0
  const arpTones = (n: number, p: number): number[] => (p ? [n + ((p >> 4) & 15), n + (p & 15)].filter((x) => x !== n) : [])
  for (const { i } of chans) {
    for (let r = 0; r < rows; r++) {
      const abs = row0 + r
      const n = tl.sounding[i]![abs]!
      if (n < 0 || tl.percussion[i]![abs]) continue
      for (const t of [n, ...arpTones(n, tl.arp[i]![abs]!)]) {
        if (t < lo) lo = t
        if (t > hi) hi = t
      }
    }
  }
  if (lo > hi) {
    lo = 48
    hi = 84
  }
  let low = Math.max(0, Math.floor((lo - 1) / 12) * 12)
  let high = Math.min(127, Math.ceil((hi + 2) / 12) * 12 - 1)
  if (high - low < 23) {
    high = Math.min(127, low + 23)
    if (high - low < 23) low = Math.max(0, high - 23)
  }
  const span = high - low + 1
  const pxSemi = Math.max(3, Math.min(10, Math.floor(360 / span)))

  const drumChannels = chans.filter(({ i }) => tl.events.some((e) => e.channel === song.channels[i]!.id && e.percussion))
  const LANE = 7
  const rollH = span * pxSemi
  const width = LEFT + rows * pxRow
  const height = TOP + rollH + (drumChannels.length ? 4 + drumChannels.length * LANE : 0) + 2
  const data = new Uint32Array(width * height)
  data.fill(pack(...BG))

  const rect = (x: number, y: number, w: number, h: number, c: [number, number, number], a = 255): void => {
    const x0 = Math.max(0, x)
    const y0 = Math.max(0, y)
    const x1 = Math.min(width, x + w)
    const y1 = Math.min(height, y + h)
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        if (a === 255) data[yy * width + xx] = pack(c[0], c[1], c[2])
        else {
          const old = data[yy * width + xx]!
          const bg: [number, number, number] = [old & 255, (old >>> 8) & 255, (old >>> 16) & 255]
          const m = mix(c, bg, a / 255)
          data[yy * width + xx] = pack(m[0], m[1], m[2])
        }
      }
    }
  }
  const text = (s: string, x: number, y: number, c: [number, number, number]): void => {
    let cx = x
    for (const ch of s) {
      const g = GLYPHS[ch]
      if (g) for (let k = 0; k < 15; k++) if (g[k] === '1') rect(cx + (k % 3), y + Math.floor(k / 3), 1, 1, c)
      cx += 4
    }
  }

  // pitch rows: black-key shading, C lines + octave labels
  const yOf = (midi: number): number => TOP + (high - midi) * pxSemi
  for (let m = low; m <= high; m++) {
    const pc = m % 12
    const black = pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10
    if (black) rect(LEFT, yOf(m), rows * pxRow, pxSemi, [27, 29, 37])
    if (pc === 0) {
      rect(LEFT, yOf(m) + pxSemi - 1, rows * pxRow, 1, [70, 74, 90])
      text(String(Math.floor(m / 12) - 1), 2, yOf(m) + pxSemi - 5, [150, 155, 175])
    }
  }

  // chip range shading for a single shown melodic channel
  if (opts.chipRange && chans.length === 1) {
    const def = songChannelDefs(song).find((d) => d.id === chans[0]!.c.id)
    if (def && !def.noise) {
      for (let m = low; m <= high; m++) if (m < def.noteMin || m > def.noteMax) rect(LEFT, yOf(m), rows * pxRow, pxSemi, [90, 30, 30], 90)
    }
  }

  // time grid
  const rpb = song.timing.rowsPerBeat
  const rpbar = rowsPerBar(song.timing)
  for (let r = 0; r <= rows; r++) {
    const x = LEFT + r * pxRow
    const inOrder = r % pl
    let c: [number, number, number] | null = null
    if (inOrder === 0) c = [140, 145, 170]
    else if (r % rpbar === 0) c = [78, 82, 100]
    else if (r % rpb === 0 && pxRow >= 3) c = [40, 43, 54]
    if (c && x < width) rect(x, TOP - (inOrder === 0 ? 3 : 0), 1, rollH + (inOrder === 0 ? 3 : 0), c)
  }
  const labelEvery = pxRow * rpbar >= 14 ? 1 : 4
  for (let b = 0; b * rpbar < rows; b += labelEvery) {
    const orderNo = fromOrder + Math.floor((b * rpbar) / pl)
    const barInOrder = Math.floor(((b * rpbar) % pl) / rpbar) + 1
    text(barInOrder === 1 ? `${orderNo}` : `${barInOrder}`, LEFT + b * rpbar * pxRow + 2, 2, barInOrder === 1 ? [190, 195, 215] : [105, 110, 130])
  }

  // notes
  const legend: PianoRollResult['legend'] = []
  chans.forEach(({ c, i }, k) => {
    const col = PALETTE[k % PALETTE.length]!
    const dim = mix(col.rgb, BG, 0.45)
    const light = mix(col.rgb, [255, 255, 255], 0.45)
    let notes = 0
    for (let r = 0; r < rows; r++) {
      const abs = row0 + r
      const n = tl.sounding[i]![abs]!
      if (n < 0 || tl.percussion[i]![abs]) continue
      const x = LEFT + r * pxRow
      for (const t of arpTones(n, tl.arp[i]![abs]!)) if (t >= low && t <= high) rect(x, yOf(t) + 1, pxRow, Math.max(1, pxSemi - 2), dim)
      if (n >= low && n <= high) rect(x, yOf(n), pxRow, pxSemi - (pxSemi > 3 ? 1 : 0), col.rgb)
    }
    for (const e of tl.events) {
      if (e.channel !== c.id || e.percussion || e.absRow < row0 || e.absRow >= row0 + rows) continue
      notes++
      if (e.midi >= low && e.midi <= high) rect(LEFT + (e.absRow - row0) * pxRow, yOf(e.midi), 1, pxSemi - (pxSemi > 3 ? 1 : 0), light)
    }
    const drums = tl.events.filter((e) => e.channel === c.id && e.percussion && e.absRow >= row0 && e.absRow < row0 + rows).length
    legend.push({ channel: c.id, color: col.name, notes, drums })
  })

  // drum lanes
  const laneTop = TOP + rollH + 4
  drumChannels.forEach(({ c }, k) => {
    const idx = chans.findIndex((x) => x.c.id === c.id)
    const col = PALETTE[idx % PALETTE.length]!
    rect(LEFT, laneTop + k * LANE, rows * pxRow, LANE - 1, [27, 29, 37])
    for (const e of tl.events) {
      if (e.channel !== c.id || !e.percussion || e.absRow < row0 || e.absRow >= row0 + rows) continue
      rect(LEFT + (e.absRow - row0) * pxRow, laneTop + k * LANE, Math.max(2, pxRow - 1), LANE - 1, col.rgb)
    }
  })

  const png = encodePng({ width, height, data })
  return { png, base64: bytesToBase64(png), width, height, fromOrder, toOrder, rows, pxPerRow: pxRow, pxPerSemitone: pxSemi, low, high, legend, truncated }
}
