// Headless mode: the MCP server with no window, the CLI flags and ffmpeg encoding.

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readWav } from '../../src/core'
import { parseCli } from '../../src/main/cli'
import { encodeAudio } from '../../src/main/ffmpeg'
import { type HeadlessServer, startHeadless } from '../../src/main/headless'
import { createDefaultRegistry } from '../../src/tools'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'chiptune-studio-headless-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function start(): Promise<{ h: HeadlessServer; client: Client }> {
  const h = await startHeadless({ port: 0, root: join(root, 'data'), token: null })
  expect(h.status.running, h.status.error).toBe(true)
  cleanup.push(() => h.stop())
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(h.status.url!)))
  cleanup.push(() => client.close().catch(() => undefined))
  return { h, client }
}

type Content = Array<{ type: string; text?: string }>
function lastJson(r: unknown): Record<string, unknown> {
  const texts = ((r as { content: unknown }).content as Content).filter((c) => c.type === 'text').map((c) => c.text!)
  return JSON.parse(texts[texts.length - 1]!) as Record<string, unknown>
}

const ffmpegOk = spawnSync(process.env['FFMPEG_PATH'] || 'ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0

describe('headless MCP server (no window)', () => {
  it('lists every tool, including the new ones, and runs a tool call on the headless song', async () => {
    const { client } = await start()
    const { tools } = await client.listTools()
    expect(tools.length).toBe(createDefaultRegistry().list().length)
    const names = tools.map((t) => t.name)
    for (const n of ['compose_track', 'render_audio', 'save_song', 'list_songs', 'open_song', 'delete_song', 'new_song', 'write_pattern', 'export_wav']) expect(names, n).toContain(n)

    // an existing tool works on the headless current song
    const made = await client.callTool({ name: 'new_song', arguments: { chip: 'nes', name: 'Headless', bpm: 100 } })
    expect(made.isError).toBeFalsy()
    const got = await client.callTool({ name: 'get_song', arguments: {} })
    expect(JSON.stringify(got.content)).toContain('Headless')

    const composed = await client.callTool({ name: 'compose_track', arguments: { mood: 'ambient', chip: 'snes', seed: 1, bars: 4 } })
    expect(composed.isError).toBeFalsy()
    const c = lastJson(composed)
    expect(c).toMatchObject({ chip: 'snes', mood: 'ambient', seed: 1, bars: 4 })
    expect(typeof c['songId']).toBe('string')
  })

  it('renders to an absolute path (wav) with loop points, and ogg when ffmpeg is installed', async () => {
    const { client } = await start()
    await client.callTool({ name: 'compose_track', arguments: { mood: 'lullaby', chip: 'gb', seed: 3, bars: 4 } })
    const wavPath = resolve(root, 'out', 'nested', 'calm.wav')
    const w = lastJson(await client.callTool({ name: 'render_audio', arguments: { path: wavPath, format: 'wav' } }))
    expect(w).toMatchObject({ path: wavPath, format: 'wav', loopStartSample: 0 })
    const wav = readWav(new Uint8Array(await readFile(wavPath)))
    expect(wav.length).toBe(w['loopEndSample'])

    const oggPath = resolve(root, 'out', 'calm.ogg')
    const o = lastJson(await client.callTool({ name: 'render_audio', arguments: { path: oggPath } }))
    if (ffmpegOk) {
      expect(o).toMatchObject({ path: oggPath, format: 'ogg' })
      expect(o['warning']).toBeUndefined()
      expect((await readFile(oggPath)).subarray(0, 4).toString('latin1')).toBe('OggS')
    } else {
      expect(o['format']).toBe('wav')
      expect(String(o['warning'])).toMatch(/ffmpeg/i)
    }
  })

  it('keeps songs across calls: save, compose another, list, reopen', async () => {
    const { client } = await start()
    const a = lastJson(await client.callTool({ name: 'compose_track', arguments: { mood: 'peaceful', chip: 'snes', seed: 1, bars: 4 } }))
    const path = resolve(root, 'songs', 'a.ctune')
    expect(lastJson(await client.callTool({ name: 'save_song', arguments: { path } }))).toEqual({ songId: a['songId'], path })
    await client.callTool({ name: 'compose_track', arguments: { mood: 'ambient', chip: 'nes', seed: 2, bars: 4 } })
    const songs = (lastJson(await client.callTool({ name: 'list_songs', arguments: {} })) as { songs: Array<{ songId: string; current: boolean }> }).songs
    expect(songs).toHaveLength(2)
    const opened = lastJson(await client.callTool({ name: 'open_song', arguments: { path } }))
    expect(opened).toMatchObject({ songId: a['songId'], path })
  })

  it('a second server on a taken port reports the bind error instead of throwing', async () => {
    const { h } = await start()
    const port = Number(new URL(h.status.url!).port)
    const second = await startHeadless({ port, root: join(root, 'data2'), token: null })
    cleanup.push(() => second.stop())
    expect(second.status.running).toBe(false)
    expect(second.status.error).toMatch(/in use/i)
  })
})

describe.runIf(ffmpegOk)('ffmpeg encoding', () => {
  it('ogg ends where the WAV ends (to within one Vorbis block) and has the same sample rate', async () => {
    const { h } = await start()
    const signal = new AbortController().signal
    await h.host.execute('compose_track', { mood: 'peaceful', chip: 'snes', seed: 1, bars: 4 }, signal)
    const wavPath = resolve(root, 'cmp', 'a.wav')
    const oggPath = resolve(root, 'cmp', 'a.ogg')
    const w = lastJson(await h.host.execute('render_audio', { path: wavPath, format: 'wav' }, signal))
    const o = lastJson(await h.host.execute('render_audio', { path: oggPath, format: 'ogg' }, signal))
    expect(o['durationSec']).toBe(w['durationSec'])
    expect((await stat(oggPath)).size).toBeGreaterThan(1000)
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate:format=duration', '-of', 'default=nw=1', oggPath], { encoding: 'utf8' })
    if (probe.status === 0) {
      const dur = Number(/duration=([\d.]+)/.exec(probe.stdout)![1])
      expect(Math.abs(dur - (w['durationSec'] as number))).toBeLessThan(0.05)
      expect(probe.stdout).toContain('sample_rate=44100')
    }
  })

  it('a missing ffmpeg falls back to a WAV with a warning', async () => {
    const dest = resolve(root, 'nf', 'x.ogg')
    const wavBytes = new Uint8Array([82, 73, 70, 70])
    const r = await encodeAudio(wavBytes, dest, 'ogg', { FFMPEG_PATH: resolve(root, 'no-such-ffmpeg.exe') })
    expect(r.format).toBe('wav')
    expect(r.path).toBe(resolve(root, 'nf', 'x.wav'))
    expect(r.warning).toMatch(/ffmpeg/i)
    expect(new Uint8Array(await readFile(r.path))).toEqual(wavBytes)
  })
})

describe('command line', () => {
  it('parses --mcp-only and --port in dev and packaged argv', () => {
    expect(parseCli(['electron', '.', '--mcp-only', '--port', '7500'])).toMatchObject({ mcpOnly: true, port: 7500, warnings: [] })
    expect(parseCli(['app.exe', '--mcp-only', '--port=7501']).port).toBe(7501)
    expect(parseCli(['app.exe']).mcpOnly).toBe(false)
    expect(parseCli(['app.exe', '--mcp-only', '--port', 'abc']).warnings[0]).toMatch(/--port/)
  })

  it("reads the argv of a second instance, where Chromium moves the switches in front of the values", () => {
    const cwd = resolve(root, 'cwd')
    const second = ['C:/app/electron.exe', '--open', '--export-to', '--export-format', '--allow-file-access-from-files', '.', 'a.ctune', 'out/b.ogg', 'ogg']
    expect(parseCli(second, cwd).open).toEqual({ path: resolve(cwd, 'a.ctune'), exportTo: resolve(cwd, 'out/b.ogg'), exportFormat: 'ogg' })
    expect(parseCli(['x.exe', '--open', '--export-to', 'a.ctune', 'b.mp3'], cwd).open).toEqual({ path: resolve(cwd, 'a.ctune'), exportTo: resolve(cwd, 'b.mp3'), exportFormat: 'mp3' })
    expect(parseCli(['x.exe', '--open=a.ctune', '--export-to=b.wav'], cwd).open).toEqual({ path: resolve(cwd, 'a.ctune'), exportTo: resolve(cwd, 'b.wav'), exportFormat: 'wav' })
  })

  it('parses --open with an export target; relative paths resolve against the working directory', () => {
    const cwd = resolve(root, 'cwd')
    const c = parseCli(['electron', '.', '--open', 'song.ctune', '--export-to', 'out/music.ogg'], cwd)
    expect(c.open).toEqual({ path: resolve(cwd, 'song.ctune'), exportTo: resolve(cwd, 'out/music.ogg'), exportFormat: 'ogg' })
    expect(parseCli(['x', '--open', 'a.ctune', '--export-to', 'b.out', '--export-format', 'wav'], cwd).open?.exportFormat).toBe('wav')
    expect(parseCli(['x', '--open', 'a.ctune', '--export-to', 'b.wav'], cwd).open?.exportFormat).toBe('wav')
    expect(parseCli(['x', '--open', 'a.ctune'], cwd).open).toEqual({ path: resolve(cwd, 'a.ctune') })
    expect(parseCli(['x', '--open'], cwd).warnings[0]).toMatch(/--open/)
  })
})
