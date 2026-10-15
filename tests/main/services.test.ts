import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNodeServices, registerServices, resolveUnder } from '../../src/main/services'
import { IPC } from '../../src/shared/ipc'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'chiptune-studio-test-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveUnder', () => {
  const base = resolve('/base/exports')
  it('places relative names in the base folder', () => {
    expect(resolveUnder(base, 'a.wav')).toBe(join(base, 'a.wav'))
    expect(resolveUnder(base, 'a.wav', 'sub')).toBe(join(base, 'sub', 'a.wav'))
  })
  it('rejects traversal out of the folder', () => {
    expect(() => resolveUnder(base, '../x.wav')).toThrow(/leaves/)
    expect(() => resolveUnder(base, 'a.wav', '../other')).toThrow(/outside/)
    expect(() => resolveUnder(base, 'sub/../../x.wav')).toThrow(/leaves/)
  })
  it('uses absolute paths as given', () => {
    const abs = resolve(root, 'elsewhere', 'a.wav')
    expect(resolveUnder(base, abs)).toBe(abs)
  })
  it('rejects empty names', () => {
    expect(() => resolveUnder(base, '  ')).toThrow()
  })
})

describe('node services', () => {
  it('creates the data folders and resolves export/project paths', async () => {
    const s = createNodeServices(join(root, 'a'))
    expect(await s.resolveExportPath('x.wav')).toBe(join(root, 'a', 'exports', 'x.wav'))
    expect(await s.resolveProjectPath('x.ctune')).toBe(join(root, 'a', 'projects', 'x.ctune'))
    await expect(s.resolveExportPath('../../evil.wav')).rejects.toThrow()
    for (const d of ['config', 'exports', 'projects', 'assets', 'chats', 'samples']) expect((await readdir(join(root, 'a', d))).length).toBe(0)
  })

  it('writes (creating parents) and reads files', async () => {
    const s = createNodeServices(join(root, 'b'))
    const p = await s.resolveExportPath('deep.txt', 'one/two')
    await s.writeFile(p, 'hello')
    expect(await readFile(p, 'utf8')).toBe('hello')
    await s.writeFile(p, new Uint8Array([1, 2, 3]))
    expect(Array.from(await s.readFile(p))).toEqual([1, 2, 3])
  })

  it('registers a handler for every fs:* channel', async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    registerServices({ handle: (c, l) => void handlers.set(c, l) }, createNodeServices(join(root, 'd')))
    const channels = Object.values(IPC).filter((c) => c.startsWith('fs:') )
    expect(channels.length).toBe(5)
    for (const c of channels) expect(handlers.has(c), c).toBe(true)
    const p = (await handlers.get(IPC.fsResolveExportPath)!({}, 'q.wav')) as string
    await handlers.get(IPC.fsWriteFile)!({}, p, 'data')
    expect(await readFile(p, 'utf8')).toBe('data')
  })
})
