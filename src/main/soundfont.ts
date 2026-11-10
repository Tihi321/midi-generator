// The gm chip's SoundFont file: found in <data folder>/soundfonts (default ~/ChiptuneStudio/soundfonts, or
// CHIPTUNE_STUDIO_HOME), read once and kept while the file is unchanged. The file is a user download (GeneralUser GS,
// see the licence next to it); it is never part of the repo or the installer.
// No Electron import: usable from the headless server, the app main process and tests.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { GM_DEFAULT_SOUNDFONT } from '../core/types'
import { SOUNDFONT_URL, describeSoundFont } from '../core/synth'
import { IPC } from '../shared/ipc'
import type { SoundFontService, SoundFontStatus } from '../tools/services'
import { defaultRoot } from './services'
import type { BridgeIpc } from './toolBridge'

/** `<root>/soundfonts` */
export function soundFontsDir(root: string = defaultRoot()): string {
  return join(root, 'soundfonts')
}

function checkFileName(file: string): string {
  const f = file.trim() || GM_DEFAULT_SOUNDFONT
  if (/[\\/]/.test(f) || f === '.' || f === '..') throw new Error(`The SoundFont "${file}" must be a file name inside the soundfonts folder, not a path.`)
  return f
}

export function missingSoundFontMessage(file: string, path: string): string {
  return `SoundFont "${file}" not found. The gm chip needs it at ${path} (the "soundfonts" folder of the Chiptune Studio data folder). Download GeneralUser-GS.sf2 from ${SOUNDFONT_URL} (releases) and put it there; soundfont_status shows what is found.`
}

export function createSoundFontService(root: string = defaultRoot()): SoundFontService {
  let cache: { path: string; mtimeMs: number; size: number; bytes: Uint8Array } | null = null

  const load = async (fileArg?: string): Promise<Uint8Array> => {
    const file = checkFileName(fileArg ?? GM_DEFAULT_SOUNDFONT)
    const path = join(soundFontsDir(root), file)
    let st
    try {
      st = await stat(path)
    } catch {
      throw new Error(missingSoundFontMessage(file, path))
    }
    if (!st.isFile()) throw new Error(missingSoundFontMessage(file, path))
    if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.bytes
    const buf = await readFile(path)
    // own the buffer exactly (the synth keeps it while the file is unchanged)
    const bytes = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    cache = { path, mtimeMs: st.mtimeMs, size: st.size, bytes }
    return bytes
  }

  return {
    load,
    async status(fileArg) {
      const file = checkFileName(fileArg ?? GM_DEFAULT_SOUNDFONT)
      const path = join(soundFontsDir(root), file)
      const base: SoundFontStatus = { state: 'missing', file, path, url: SOUNDFONT_URL }
      let size: number
      try {
        const st = await stat(path)
        if (!st.isFile()) return { ...base, message: missingSoundFontMessage(file, path) }
        size = st.size
      } catch {
        return { ...base, message: missingSoundFontMessage(file, path) }
      }
      try {
        const bytes = await load(file)
        const info = describeSoundFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
        return { ...base, state: 'present', sizeBytes: size, title: info.name, presets: info.presets, drumKits: info.drumKits }
      } catch (e) {
        return {
          ...base,
          state: 'invalid',
          sizeBytes: size,
          message: `${path} is not a readable SoundFont (${e instanceof Error ? e.message : String(e)}). Use an uncompressed .sf2 such as GeneralUser-GS.sf2 from ${SOUNDFONT_URL}.`
        }
      }
    }
  }
}

/** Register the soundfont:* handlers (the app window reads the SoundFont through them). */
export function registerSoundFont(ipc: BridgeIpc, service: SoundFontService = createSoundFontService()): SoundFontService {
  ipc.handle(IPC.soundfontStatus, (_e, file) => service.status(typeof file === 'string' ? file : undefined))
  ipc.handle(IPC.soundfontLoad, (_e, file) => service.load(typeof file === 'string' ? file : undefined))
  return service
}
