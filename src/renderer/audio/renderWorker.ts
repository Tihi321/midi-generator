// Offline render worker: renders a song snapshot with renderSong and returns the Float32 buffers (transferred).
// renderSong has no progress callback, so progress is coarse: started, rendered, delivered.

import { renderSong } from '../../core/synth'
import type { FromRenderWorker, ToRenderWorker } from './protocol'

declare const self: {
  onmessage: ((e: MessageEvent<ToRenderWorker>) => void) | null
  postMessage(msg: FromRenderWorker, transfer?: Transferable[]): void
}

self.onmessage = (e: MessageEvent<ToRenderWorker>) => {
  const msg = e.data
  if (msg.type !== 'render') return
  const { id, song, opts } = msg
  try {
    self.postMessage({ type: 'progress', id, fraction: 0.05, label: 'Rendering' })
    const r = renderSong(song, {
      sampleRate: opts.sampleRate ?? 44100,
      loops: opts.loops ?? 1,
      fadeOutSec: opts.fadeOutSec ?? 0,
      stems: opts.stems ?? false
    })
    self.postMessage({ type: 'progress', id, fraction: 0.9, label: 'Packaging' })
    const transfer: Transferable[] = [r.L.buffer as ArrayBuffer, r.R.buffer as ArrayBuffer]
    if (r.stems) for (const s of Object.values(r.stems)) transfer.push(s.L.buffer as ArrayBuffer, s.R.buffer as ArrayBuffer)
    self.postMessage(
      {
        type: 'done',
        id,
        result: { sampleRate: r.sampleRate, L: r.L, R: r.R, stems: r.stems, loopStart: r.loopStart, loopEnd: r.loopEnd }
      },
      transfer
    )
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
  }
}
