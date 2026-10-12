// Main-thread side of the offline render: runs renderSong in a module Worker (so the UI stays responsive) and
// falls back to rendering in-process when there is no Worker (tests, Node).

import { renderSong } from '../../core/synth'
import type { Song } from '../../core/types'
import type { AudioRenderOptions, AudioRenderResult } from '../../tools/services'
import type { FromRenderWorker, ToRenderWorker } from './protocol'

export type RenderProgress = (fraction: number, label: string) => void

let nextId = 1

export async function renderOffline(song: Song, opts: AudioRenderOptions = {}, onProgress?: RenderProgress): Promise<AudioRenderResult> {
  if (typeof Worker === 'undefined') {
    onProgress?.(0.05, 'Rendering')
    const r = renderSong(song, { sampleRate: opts.sampleRate ?? 44100, loops: opts.loops ?? 1, fadeOutSec: opts.fadeOutSec ?? 0, stems: opts.stems ?? false })
    onProgress?.(1, 'Done')
    return { sampleRate: r.sampleRate, L: r.L, R: r.R, stems: r.stems, loopStart: r.loopStart, loopEnd: r.loopEnd }
  }
  const worker = new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' })
  const id = nextId++
  return new Promise<AudioRenderResult>((resolve, reject) => {
    const done = (): void => worker.terminate()
    worker.onmessage = (e: MessageEvent<FromRenderWorker>) => {
      const m = e.data
      if (m.id !== id) return
      if (m.type === 'progress') onProgress?.(m.fraction, m.label)
      else if (m.type === 'done') {
        onProgress?.(1, 'Done')
        done()
        resolve(m.result)
      } else {
        done()
        reject(new Error(m.message))
      }
    }
    worker.onerror = (ev) => {
      done()
      reject(new Error(ev.message || 'The render worker failed to start.'))
    }
    const msg: ToRenderWorker = { type: 'render', id, song, opts }
    worker.postMessage(msg)
  })
}
