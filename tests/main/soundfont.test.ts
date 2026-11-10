// The gm chip's SoundFont file in the data folder: a missing file is a clear error with the path and the download address
// (render_audio) and "missing" (soundfont_status); a present file renders.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setSoundFont } from '../../src/core'
import { createHeadlessHost } from '../../src/main/headless'
import { type ToolHost, resultText } from '../../src/tools'
import { buildMiniSoundFont } from '../core/miniSf2'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'chiptune-studio-sf-'))
})
afterAll(async () => {
  setSoundFont(null)
  await rm(root, { recursive: true, force: true })
})

const run = (host: ToolHost, name: string, args: unknown) => host.execute(name, args, new AbortController().signal)

describe('gm SoundFont file', () => {
  it('names soundfonts\\GeneralUser-GS.sf2 and the download address when it is missing, and reports missing', async () => {
    const { host } = createHeadlessHost(join(root, 'empty'))
    const status = await run(host, 'soundfont_status', {})
    expect(status.isError).toBeFalsy()
    expect(resultText(status)).toContain('"state":"missing"')

    await run(host, 'compose_track', { mood: 'storybook', chip: 'gm', seed: 1, bars: 4 })
    const r = await run(host, 'render_audio', { path: join(root, 'out.wav'), format: 'wav' })
    expect(r.isError).toBe(true)
    const text = resultText(r)
    expect(text).toContain(join('soundfonts', 'GeneralUser-GS.sf2'))
    expect(text).toContain('https://github.com/mrbumpy409/GeneralUser-GS')
  })

  it('renders a gm song headless once the file is in the soundfonts folder', async () => {
    const data = join(root, 'data')
    await mkdir(join(data, 'soundfonts'), { recursive: true })
    await writeFile(join(data, 'soundfonts', 'GeneralUser-GS.sf2'), buildMiniSoundFont())
    const { host } = createHeadlessHost(data)
    expect(resultText(await run(host, 'soundfont_status', {}))).toContain('"state":"present"')
    expect((await run(host, 'compose_track', { mood: 'storybook', chip: 'gm', seed: 1, bars: 4 })).isError).toBeFalsy()
    const r = await run(host, 'render_audio', { path: join(root, 'ok.wav'), format: 'wav' })
    expect(r.isError, resultText(r)).toBeFalsy()
  })
})
