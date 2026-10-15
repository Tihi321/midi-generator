// Main-process implementation of ToolServices: file IO and export/project path resolution under the data root
// (~/ChiptuneStudio), exposed to the renderer through ipcMain.handle (see IPC.fs*).
// No Electron import: `registerServices` receives an ipcMain-like object, so this is testable.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { IPC } from '../shared/ipc'
import type { AudioFormat, EncodeResult } from '../tools/services'
import { encodeAudio } from './ffmpeg'
import type { BridgeIpc } from './toolBridge'

export interface ChiptuneStudioPaths {
  root: string
  exports: string
  projects: string
  assets: string
  chats: string
  config: string
  samples: string
}

/** `~/ChiptuneStudio`, or the folder in the CHIPTUNE_STUDIO_HOME environment variable (used by tests / e2e runs). */
export function defaultRoot(): string {
  const override = process.env['CHIPTUNE_STUDIO_HOME']?.trim()
  return override ? resolve(override) : join(homedir(), 'ChiptuneStudio')
}

export function chiptuneStudioPaths(root: string = defaultRoot()): ChiptuneStudioPaths {
  return { root, exports: join(root, 'exports'), projects: join(root, 'projects'), assets: join(root, 'assets'), chats: join(root, 'chats'), config: join(root, 'config'), samples: join(root, 'samples') }
}

async function ensureDirs(paths: ChiptuneStudioPaths): Promise<void> {
  await Promise.all([paths.exports, paths.projects, paths.assets, paths.chats, paths.config, paths.samples].map((d) => mkdir(d, { recursive: true })))
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** True when `target` is `base` or inside it. */
function isInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolve a file name for an export/project: an absolute `name` is used as is; a relative one goes into
 * `dir` (default `base`; a relative `dir` is relative to `base`; an absolute `dir` is used as is). A
 * relative name or dir that escapes `base` (e.g. "../x") is rejected.
 */
export function resolveUnder(base: string, name: string, dir?: string): string {
  const n = expandHome(name.trim())
  if (!n) throw new Error('The file name is empty.')
  if (isAbsolute(n)) return resolve(n)
  let folder = base
  if (dir && dir.trim()) {
    const d = expandHome(dir.trim())
    if (isAbsolute(d)) folder = resolve(d)
    else {
      folder = resolve(base, d)
      if (!isInside(base, folder)) throw new Error(`The folder "${dir}" is outside ${base}. Use a path inside it or an absolute path.`)
    }
  }
  const full = resolve(folder, n)
  if (!isInside(folder, full)) throw new Error(`The file name "${name}" leaves the output folder ${folder}. Use a plain file name or an absolute path.`)
  return full
}

export interface NodeServices {
  paths: ChiptuneStudioPaths
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  resolveExportPath(name: string, dir?: string): Promise<string>
  resolveProjectPath(name: string, dir?: string): Promise<string>
  /** ogg/mp3 through ffmpeg (FFMPEG_PATH or PATH); wav fallback with a warning. */
  encodeAudio(wav: Uint8Array, path: string, format: AudioFormat): Promise<EncodeResult>
}

export function createNodeServices(root: string = defaultRoot()): NodeServices {
  const paths = chiptuneStudioPaths(root)

  return {
    paths,
    async writeFile(path, data) {
      const full = resolve(expandHome(path))
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, data)
    },
    async readFile(path) {
      const buf = await readFile(resolve(expandHome(path)))
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    },
    async resolveExportPath(name, dir) {
      await ensureDirs(paths)
      return resolveUnder(paths.exports, name, dir)
    },
    async resolveProjectPath(name, dir) {
      await ensureDirs(paths)
      return resolveUnder(paths.projects, name, dir)
    },
    async encodeAudio(wav, path, format) {
      return encodeAudio(wav, resolve(expandHome(path)), format)
    }
  }
}

/** Register the fs:* handlers. */
export function registerServices(ipc: BridgeIpc, services: NodeServices = createNodeServices()): NodeServices {
  ipc.handle(IPC.fsWriteFile, (_e, path, data) => services.writeFile(String(path), data as Uint8Array | string))
  ipc.handle(IPC.fsReadFile, (_e, path) => services.readFile(String(path)))
  ipc.handle(IPC.fsResolveExportPath, (_e, name, dir) => services.resolveExportPath(String(name), typeof dir === 'string' ? dir : undefined))
  ipc.handle(IPC.fsResolveProjectPath, (_e, name, dir) => services.resolveProjectPath(String(name), typeof dir === 'string' ? dir : undefined))
  ipc.handle(IPC.fsEncodeAudio, (_e, wav, path, format) => services.encodeAudio(wav as Uint8Array, String(path), (format === 'mp3' || format === 'wav' ? format : 'ogg') as AudioFormat))
  return services
}
