// File IO for the renderer, through the main process (window.chiptuneStudio.invoke).
//
// Payloads: file contents travel as Uint8Array (Electron IPC structured clone) or string (UTF-8 text).
// Calls follow the ToolServices signatures: fs:writeFile(path, data), fs:readFile(path),
// fs:resolveExportPath(name, dir?), fs:resolveProjectPath(name, dir?).

import { IPC } from '../../shared/ipc'
import type { ExportFile } from './exporter'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const api = typeof window === 'undefined' ? undefined : window.chiptuneStudio
  if (!api) return Promise.reject(new Error('File access is not available (no preload bridge).'))
  return api.invoke<T>(channel, ...args)
}

/** Normalise whatever main returns for binary data into a Uint8Array. */
export function toBytes(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x
  if (x instanceof ArrayBuffer) return new Uint8Array(x)
  if (typeof x === 'string') return new TextEncoder().encode(x)
  if (Array.isArray(x)) return Uint8Array.from(x as number[])
  if (x && typeof x === 'object' && 'data' in x) return toBytes((x as { data: unknown }).data)
  throw new Error('Unexpected file data received from the main process.')
}

export function writeFile(path: string, data: Uint8Array | string): Promise<void> {
  return invoke<void>(IPC.fsWriteFile, path, data)
}

export async function readFile(path: string): Promise<Uint8Array> {
  return toBytes(await invoke<unknown>(IPC.fsReadFile, path))
}

export function resolveExportPath(name: string, dir?: string): Promise<string> {
  return dir ? invoke<string>(IPC.fsResolveExportPath, name, dir) : invoke<string>(IPC.fsResolveExportPath, name)
}

export function resolveProjectPath(name: string, dir?: string): Promise<string> {
  return dir ? invoke<string>(IPC.fsResolveProjectPath, name, dir) : invoke<string>(IPC.fsResolveProjectPath, name)
}

/** Write planned export files into the exports folder; returns the absolute paths written. */
export async function writeExportFiles(files: ExportFile[], dir = ''): Promise<string[]> {
  const paths: string[] = []
  for (const f of files) {
    const path = await resolveExportPath(f.name, dir.trim() || undefined)
    await writeFile(path, f.data)
    paths.push(path)
  }
  return paths
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
