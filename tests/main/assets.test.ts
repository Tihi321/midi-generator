import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetStore, defaultAssetsDir, matchesFilter, parseMetaFile, registerAssetIpc, serializeMetaFile, slugify } from '../../src/main/assets'
import { defaultRoot } from '../../src/main/services'
import { ASSETS_IPC } from '../../src/shared/assets'
import type { AssetMeta } from '../../src/tools/services'

const dirs: string[] = []
async function tempRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'chiptune-studio-assets-'))
  dirs.push(d)
  return join(d, 'assets')
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const meta = (over: Partial<Omit<AssetMeta, 'id'>> & { id?: string } = {}): Omit<AssetMeta, 'id'> & { id?: string } => ({
  name: 'Knight',
  kind: 'motif',
  chip: 'nes',
  tags: ['fantasy'],
  moods: ['heroic', 'battle'],
  key: 'A',
  scale: 'minor',
  bpm: 140,
  rowsPerBeat: 4,
  channels: ['P1', 'TR'],
  roles: ['lead', 'bass'],
  rows: 32,
  notes: 'Galloping bass.\nBrass-like lead.',
  ...over
})

describe('slugify', () => {
  it('makes folder-safe slugs', () => {
    expect(slugify('Red Knight!')).toBe('red-knight')
    expect(slugify('  --Ünïcode & spaces--  ')).toBe('n-code-spaces')
    expect(slugify('***')).toBe('asset')
    expect(slugify('a'.repeat(100)).length).toBe(48)
  })
})

describe('meta.md', () => {
  it('round-trips frontmatter and notes', () => {
    const m: AssetMeta = { id: 'knight', ...meta() } as AssetMeta
    const text = serializeMetaFile(m)
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toMatch(/\nkind: motif\n/)
    expect(text).toMatch(/\nchip: nes\n/)
    expect(text).toMatch(/\nkey: A\n/)
    expect(text).toMatch(/\nrows: 32\n/)
    expect(text.endsWith('---\nGalloping bass.\nBrass-like lead.\n')).toBe(true)
    expect(parseMetaFile('knight', text)).toEqual(m)
  })

  it('is lenient about missing or wrong fields and takes the id from the folder', () => {
    expect(parseMetaFile('x', '---\nid: other\nkind: banana\nchip: amiga\ntags: [A, a, b]\n---\n')).toEqual({
      id: 'x',
      name: 'x',
      kind: 'song',
      chip: 'nes',
      tags: ['a', 'b'],
      moods: [],
      key: 'C',
      scale: 'major',
      bpm: 120,
      rowsPerBeat: 4,
      channels: [],
      roles: [],
      rows: 0
    })
    expect(parseMetaFile('y', 'no frontmatter')).toMatchObject({ id: 'y', name: 'y' })
    expect(parseMetaFile('z', '---\n: : bad: [\n---\n')).toBeNull()
  })

  it('filters by kind, chip, tags, mood and text', () => {
    const m = { id: 'a', ...meta({ tags: ['x', 'y'] }) } as AssetMeta
    expect(matchesFilter(m)).toBe(true)
    expect(matchesFilter(m, { kind: 'motif', tags: ['X'] })).toBe(true)
    expect(matchesFilter(m, { kind: 'song' })).toBe(false)
    expect(matchesFilter(m, { chip: 'gb' })).toBe(false)
    expect(matchesFilter(m, { tags: ['x', 'z'] })).toBe(false)
    expect(matchesFilter(m, { mood: 'Battle' })).toBe(true)
    expect(matchesFilter(m, { mood: 'sad' })).toBe(false)
    expect(matchesFilter(m, { text: 'brass lead' })).toBe(true)
    expect(matchesFilter(m, { text: 'brass flute' })).toBe(false)
  })
})

describe('AssetStore', () => {
  let store: AssetStore
  beforeEach(async () => {
    store = new AssetStore(await tempRoot())
  })

  it('saves, lists, gets and deletes', async () => {
    expect(await store.list()).toEqual([])
    const saved = await store.save({ meta: meta(), project: '{"ctune":1}', thumbnail: PNG })
    expect(saved).toMatchObject({ id: 'knight', name: 'Knight', kind: 'motif', chip: 'nes', tags: ['fantasy'], moods: ['heroic', 'battle'], key: 'A', scale: 'minor', bpm: 140, rows: 32, notes: 'Galloping bass.\nBrass-like lead.' })
    // the folder layout
    expect(await readFile(join(store.root, 'knight', 'asset.ctune'), 'utf8')).toBe('{"ctune":1}')
    expect(Array.from(await readFile(join(store.root, 'knight', 'thumb.png')))).toEqual(Array.from(PNG))
    expect(await readFile(join(store.root, 'knight', 'meta.md'), 'utf8')).toMatch(/^---\nid: knight\nname: Knight\n/)

    expect(await store.list()).toEqual([saved])
    const got = await store.get('knight')
    expect(got).toEqual({ ...saved, project: '{"ctune":1}' })
    expect(Array.from((await store.thumbnail('knight'))!)).toEqual(Array.from(PNG))
    expect(await store.get('nope')).toBeNull()
    expect(await store.thumbnail('nope')).toBeNull()

    expect(await store.delete('knight')).toBe(true)
    expect(await store.delete('knight')).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('gives unique slugs and overwrites when the id is given', async () => {
    const a = await store.save({ meta: meta(), project: 'a' })
    const b = await store.save({ meta: meta(), project: 'b' })
    const c = await store.save({ meta: meta({ name: 'Knight!' }), project: 'c' })
    expect([a.id, b.id, c.id]).toEqual(['knight', 'knight-2', 'knight-3'])
    const over = await store.save({ meta: meta({ id: 'knight', name: 'Renamed', tags: ['x'], notes: undefined }), project: 'new' })
    expect(over).toMatchObject({ id: 'knight', name: 'Renamed', tags: ['x'] })
    expect(over.notes).toBeUndefined()
    expect((await store.get('knight'))!.project).toBe('new')
    expect(await store.list()).toHaveLength(3)
  })

  it('keeps the old thumbnail when an overwrite has none', async () => {
    await store.save({ meta: meta(), project: 'a', thumbnail: PNG })
    await store.save({ meta: meta({ id: 'knight' }), project: 'b' })
    expect(await store.thumbnail('knight')).not.toBeNull()
  })

  it('filters the listing and sorts by name', async () => {
    await store.save({ meta: meta({ name: 'Zed', tags: ['a', 'b'] }), project: '' })
    await store.save({ meta: meta({ name: 'Amy', kind: 'song', chip: 'gb', tags: ['a'], moods: ['sad'] }), project: '' })
    await store.save({ meta: meta({ name: 'Mid', kind: 'instrument', tags: [] }), project: '' })
    expect((await store.list()).map((m) => m.name)).toEqual(['Amy', 'Mid', 'Zed'])
    expect((await store.list({ kind: 'song' })).map((m) => m.name)).toEqual(['Amy'])
    expect((await store.list({ chip: 'gb' })).map((m) => m.name)).toEqual(['Amy'])
    expect((await store.list({ mood: 'sad' })).map((m) => m.name)).toEqual(['Amy'])
    expect((await store.list({ tags: ['a'] })).map((m) => m.name)).toEqual(['Amy', 'Zed'])
    expect((await store.list({ tags: ['a', 'b'] })).map((m) => m.name)).toEqual(['Zed'])
    expect((await store.list({ text: 'mid' })).map((m) => m.name)).toEqual(['Mid'])
  })

  it('rejects bad input and ignores stray folders', async () => {
    await expect(store.save({ meta: meta({ name: '  ' }), project: '' })).rejects.toThrow(/name/)
    await expect(store.save({ meta: meta({ id: '../evil' }), project: '' })).rejects.toThrow(/Invalid asset id/)
    expect(await store.get('../evil')).toBeNull()
    expect(await store.delete('../evil')).toBe(false)
    await mkdir(join(store.root, 'stray'), { recursive: true })
    await writeFile(join(store.root, 'stray', 'readme.txt'), 'x')
    await writeFile(join(store.root, 'file.txt'), 'x')
    await mkdir(join(store.root, 'Not Valid'), { recursive: true })
    expect(await store.list()).toEqual([])
  })

  it('picks up a hand-edited meta.md', async () => {
    await store.save({ meta: meta(), project: 'a' })
    await writeFile(join(store.root, 'knight', 'meta.md'), '---\nname: Hand edited\nkind: instrument\nchip: gb\ntags: [one]\nbpm: 90\n---\nNew notes\n')
    expect(await store.get('knight')).toMatchObject({ name: 'Hand edited', kind: 'instrument', chip: 'gb', tags: ['one'], notes: 'New notes', bpm: 90 })
  })

  it('watch() reports changes in the folder (debounced)', async () => {
    const onChange = vi.fn()
    const stop = await store.watch(onChange, 50)
    try {
      await store.save({ meta: meta(), project: 'a', thumbnail: PNG })
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 8000, interval: 50 })
    } finally {
      await stop()
    }
  })
})

describe('registerAssetIpc', () => {
  it('serves the assets:* channels and notifies after changes', async () => {
    const store = new AssetStore(await tempRoot())
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const notify = vi.fn()
    registerAssetIpc({ handle: (c, l) => void handlers.set(c, l) }, store, notify)
    const call = (c: string, ...a: unknown[]): Promise<unknown> => Promise.resolve(handlers.get(c)!({}, ...a))
    const saved = (await call(ASSETS_IPC.save, { meta: meta(), project: 'p', thumbnail: PNG })) as AssetMeta
    expect(saved.id).toBe('knight')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(((await call(ASSETS_IPC.list, null)) as AssetMeta[]).map((m) => m.id)).toEqual(['knight'])
    expect((await call(ASSETS_IPC.list, { kind: 'song' })) as AssetMeta[]).toEqual([])
    expect(((await call(ASSETS_IPC.get, 'knight')) as { project: string }).project).toBe('p')
    expect(Array.from((await call(ASSETS_IPC.thumbnail, 'knight')) as Uint8Array)).toEqual(Array.from(PNG))
    expect(await call(ASSETS_IPC.delete, 'knight')).toBe(true)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(await call(ASSETS_IPC.delete, 'knight')).toBe(false)
    expect(notify).toHaveBeenCalledTimes(2)
  })
})

describe('asset files written by the save_as_asset tool', () => {
  it('a real song asset round-trips through the store and the tools', async () => {
    const { songSetup } = await import('../tools/helpers')
    const { parseProject } = await import('../../src/core')
    const t = songSetup()
    await t.ok('new_song', { chip: 'nes', name: 'Disk', key: 'E', scale: 'minor' })
    await t.ok('add_instrument', { preset: 'lead', channel: 'P1' })
    await t.ok('write_melody', { channel: 'P1', melody: '@lead E5:4 G5:4' })
    await t.ok('save_as_asset', { name: 'Disk song', kind: 'song', notes: 'A note.' })
    const mem = t.services.assets.items.get('disk-song')!
    const store = new AssetStore(await tempRoot())
    const saved = await store.save({ meta: { ...mem, id: undefined } as never, project: mem.project, thumbnail: mem.thumbnail })
    expect(saved).toMatchObject({ id: 'disk-song', kind: 'song', chip: 'nes', key: 'E', scale: 'minor', channels: ['P1'], notes: 'A note.' })
    expect((await store.get('disk-song'))!.project).toBe(mem.project)
    expect(parseProject((await store.get('disk-song'))!.project).name).toBe('Disk song')
    expect((await store.thumbnail('disk-song'))!.length).toBeGreaterThan(100)
  })
})

describe('CHIPTUNE_STUDIO_HOME', () => {
  it('moves the data root (and so the assets folder)', () => {
    const prev = process.env['CHIPTUNE_STUDIO_HOME']
    try {
      process.env['CHIPTUNE_STUDIO_HOME'] = join(tmpdir(), 'cs-home-override')
      expect(defaultRoot()).toBe(join(tmpdir(), 'cs-home-override'))
      expect(defaultAssetsDir()).toBe(join(tmpdir(), 'cs-home-override', 'assets'))
      delete process.env['CHIPTUNE_STUDIO_HOME']
      expect(defaultRoot()).toMatch(/ChiptuneStudio$/)
    } finally {
      if (prev === undefined) delete process.env['CHIPTUNE_STUDIO_HOME']
      else process.env['CHIPTUNE_STUDIO_HOME'] = prev
    }
  })
})
