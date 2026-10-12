// Offline rendering with sample-accurate seamless loops.
//
// Looping songs: the player renders intro + (loops + 1) bodies. The output keeps the intro (first pass) and
// the bodies 2..loops+1, with a <= 5 ms crossfade at the single intro -> loop seam (the intro's tail fades
// into the end of body 1, which leads straight into the start of body 2). The wrap loopEnd -> loopStart then
// goes from "end of a body that followed a body" to "start of a body that followed a body", i.e. it already
// contains the release / echo tails and is as continuous as the song itself.

import type { Song } from '../types'
import type { MixModel, StemBuffer } from './mixer'
import { SongPlayer } from './player'
import { buildTimeline } from './timeline'

export interface RenderOptions {
  sampleRate?: 44100 | 48000 | number
  /** Times the loop body is present in the output (default 1 = intro + one body). */
  loops?: number
  /** Fade-out length. With a looping song the output becomes intro + `loops` bodies + a fade (no loop points). */
  fadeOutSec?: number
  /** Also return one stereo stem per channel (pre-limiter, keyed by channel id). */
  stems?: boolean
  /** Extra tail rendered after a one-shot song ends (default 0.5 s). */
  tailSec?: number
  mixModel?: MixModel
}

export interface StemPair {
  L: Float32Array
  R: Float32Array
}

export interface RenderResult {
  L: Float32Array
  R: Float32Array
  stems?: Record<string, StemPair>
  /** Loop start/end sample indices (end exclusive), null for one-shot or faded output. */
  loopStart: number | null
  loopEnd: number | null
  sampleRate: number
}

const BLOCK = 4096
const CROSSFADE_SEC = 0.005

/** `stems` holds one pair per channel followed by one per shared bus (e.g. the SNES '_echo'); `names` are their ids. */
function renderFrames(song: Song, sampleRate: number, total: number, stems: boolean, mixModel: MixModel | undefined): { L: Float32Array; R: Float32Array; stems: StemPair[]; names: string[] } {
  const player = new SongPlayer(song, sampleRate, { maxBlock: BLOCK, mixModel })
  const L = new Float32Array(total)
  const R = new Float32Array(total)
  const names = [...song.channels.map((c) => c.id), ...player.auxIds]
  const nCh = song.channels.length
  const st: StemPair[] = stems ? names.map(() => ({ L: new Float32Array(total), R: new Float32Array(total) })) : []
  for (let off = 0; off < total; off += BLOCK) {
    const end = Math.min(total, off + BLOCK)
    const views: StemBuffer[] | undefined = stems ? st.map((s) => ({ L: s.L.subarray(off, end), R: s.R.subarray(off, end) })) : undefined
    player.process(L.subarray(off, end), R.subarray(off, end), views?.slice(0, nCh), views?.slice(nCh))
  }
  return { L, R, stems: st, names }
}

function applyFade(bufs: Float32Array[], fadeSamples: number): void {
  for (const b of bufs) {
    const n = Math.min(fadeSamples, b.length)
    for (let i = 0; i < n; i++) {
      const g = 0.5 * (1 + Math.cos((Math.PI * (i + 1)) / n))
      const idx = b.length - n + i
      b[idx] = b[idx]! * g
    }
  }
}

export function renderSong(song: Song, opts: RenderOptions = {}): RenderResult {
  const sr = opts.sampleRate ?? 44100
  const loops = Math.max(1, Math.floor(opts.loops ?? 1))
  const fade = Math.max(0, opts.fadeOutSec ?? 0)
  const fadeSamples = Math.round(fade * sr)
  const wantStems = opts.stems === true
  const tl = buildTimeline(song)

  const pack = (L: Float32Array, R: Float32Array, st: StemPair[], names: string[], loopStart: number | null, loopEnd: number | null): RenderResult => {
    const res: RenderResult = { L, R, loopStart, loopEnd, sampleRate: sr }
    if (wantStems) {
      res.stems = {}
      names.forEach((id, i) => {
        res.stems![id] = st[i]!
      })
    }
    return res
  }

  if (!tl.isLooping) {
    const b = tl.sampleBoundaries(sr, 0)
    const total = b.introEnd + Math.round((opts.tailSec ?? 0.5) * sr)
    const r = renderFrames(song, sr, total, wantStems, opts.mixModel)
    if (fadeSamples > 0) applyFade([r.L, r.R, ...r.stems.flatMap((s) => [s.L, s.R])], fadeSamples)
    return pack(r.L, r.R, r.stems, r.names, null, null)
  }

  if (fadeSamples > 0) {
    const b = tl.sampleBoundaries(sr, loops)
    const total = b.bodyEnds[loops - 1]! + fadeSamples
    const r = renderFrames(song, sr, total, wantStems, opts.mixModel)
    applyFade([r.L, r.R, ...r.stems.flatMap((s) => [s.L, s.R])], fadeSamples)
    return pack(r.L, r.R, r.stems, r.names, null, null)
  }

  const b = tl.sampleBoundaries(sr, loops + 1)
  const introEnd = b.introEnd
  const bodyStart = b.bodyEnds[0]!
  const total = b.bodyEnds[loops]!
  const r = renderFrames(song, sr, total, wantStems, opts.mixModel)
  const outLen = introEnd + (total - bodyStart)
  const xf = Math.min(Math.round(CROSSFADE_SEC * sr), introEnd)

  const assemble = (src: Float32Array): Float32Array => {
    const out = new Float32Array(outLen)
    out.set(src.subarray(0, introEnd), 0)
    out.set(src.subarray(bodyStart, total), introEnd)
    for (let i = 0; i < xf; i++) {
      const w = (i + 1) / (xf + 1)
      out[introEnd - xf + i] = src[introEnd - xf + i]! * (1 - w) + src[bodyStart - xf + i]! * w
    }
    return out
  }
  const L = assemble(r.L)
  const R = assemble(r.R)
  const stems = r.stems.map((s) => ({ L: assemble(s.L), R: assemble(s.R) }))
  const loopStart = introEnd + (b.bodyEnds[loops - 1]! - bodyStart)
  return pack(L, R, stems, r.names, loopStart, outLen)
}
