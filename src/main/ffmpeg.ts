// Encode a WAV to ogg (Vorbis) or mp3 with ffmpeg: the binary comes from FFMPEG_PATH, else from PATH. Without ffmpeg (or
// when it fails) the WAV is written next to the requested path and the result carries a warning, so render_audio always
// leaves a usable file. No Electron import.

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AudioFormat, EncodeResult } from '../tools/services'

const FORMAT_ARGS: Record<'ogg' | 'mp3', string[]> = {
  ogg: ['-c:a', 'libvorbis', '-q:a', '6', '-f', 'ogg'],
  mp3: ['-c:a', 'libmp3lame', '-q:a', '2', '-f', 'mp3']
}

export function ffmpegCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env['FFMPEG_PATH']?.trim() || 'ffmpeg'
}

interface RunResult {
  ok: boolean
  /** Why it did not work (spawn error or ffmpeg's last stderr lines). */
  reason?: string
}

function runFfmpeg(command: string, wav: Uint8Array, dest: string, format: 'ogg' | 'mp3'): Promise<RunResult> {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const done = (r: RunResult): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    let child
    try {
      child = spawn(command, ['-y', '-v', 'error', '-i', 'pipe:0', ...FORMAT_ARGS[format], dest], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    } catch (e) {
      done({ ok: false, reason: e instanceof Error ? e.message : String(e) })
      return
    }
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-600)
    })
    child.on('error', (e: NodeJS.ErrnoException) => done({ ok: false, reason: e.code === 'ENOENT' ? `"${command}" was not found` : e.message }))
    child.on('close', (code) => done(code === 0 ? { ok: true } : { ok: false, reason: `ffmpeg exited with code ${code}: ${stderr.trim().split('\n').pop() ?? ''}` }))
    child.stdin.on('error', () => undefined) // EPIPE when ffmpeg dies early; 'close' reports it
    child.stdin.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength))
  })
}

/** ogg/mp3 through ffmpeg; wav (or any failure) writes the WAV. `dest` has the extension of `format`. */
export async function encodeAudio(wav: Uint8Array, dest: string, format: AudioFormat, env: NodeJS.ProcessEnv = process.env): Promise<EncodeResult> {
  await mkdir(dirname(dest), { recursive: true })
  if (format !== 'wav') {
    const r = await runFfmpeg(ffmpegCommand(env), wav, dest, format)
    if (r.ok) return { path: dest, format }
    const wavPath = dest.replace(/\.[a-z0-9]{1,5}$/i, '') + '.wav'
    await writeFile(wavPath, wav)
    return {
      path: wavPath,
      format: 'wav',
      warning: `Could not encode ${format} (${r.reason}). Install ffmpeg or set FFMPEG_PATH; wrote a WAV (with loop points) instead.`
    }
  }
  await writeFile(dest, wav)
  return { path: dest, format: 'wav' }
}
