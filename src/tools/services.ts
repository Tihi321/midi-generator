// ToolServices: the side-effecting capabilities tools need (files, later audio and the library).
// No DOM, no Electron. Implemented by main over IPC (src/renderer/toolBridgeClient.ts) and in memory for tests.

import type { ChipId, PitchClass, Song } from '../core/types'

export type AssetKind = 'song' | 'motif' | 'instrument'

/** Metadata of a library asset (stored as meta.md frontmatter; the body of meta.md is `notes`). */
export interface AssetMeta {
  id: string
  name: string
  kind: AssetKind
  chip: ChipId
  tags: string[]
  moods: string[]
  key: PitchClass
  scale: string
  bpm: number
  rowsPerBeat: number
  /** Ids of the channels that hold notes (motif/song) or the channel an instrument demo plays on. */
  channels: string[]
  /** Instrument roles used. */
  roles: string[]
  /** Length in rows (orders x pattern length); 0 for an instrument. */
  rows: number
  /** Free-text style notes. */
  notes?: string
}

export interface AssetFilter {
  kind?: AssetKind
  chip?: ChipId
  /** Assets that have ALL of these tags. */
  tags?: string[]
  /** Assets that have this mood. */
  mood?: string
  /** Every word must match the name, a tag, a mood or the notes. */
  text?: string
}

export interface AssetData extends AssetMeta {
  /** The asset as .ctune project text. */
  project: string
}

export interface AssetSaveInput {
  meta: Omit<AssetMeta, 'id'> & { id?: string }
  /** The asset as .ctune project text. */
  project: string
  /** Thumbnail PNG bytes. */
  thumbnail?: Uint8Array
}

/** The asset library (~/ChiptuneStudio/assets; see src/main/assets.ts). */
export interface AssetService {
  list(filter?: AssetFilter): Promise<AssetMeta[]>
  get(id: string): Promise<AssetData | null>
  /** Saves (a given `meta.id` overwrites that asset) and returns the stored metadata, with its id. */
  save(input: AssetSaveInput): Promise<AssetMeta>
  delete(id: string): Promise<boolean>
  /** Thumbnail PNG bytes, or null when the asset or its thumbnail does not exist. */
  thumbnail(id: string): Promise<Uint8Array | null>
}

export interface ToolServices {
  /** Write a file (creating parent folders). Text is UTF-8. Rejects when the path is not allowed. */
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  /** Read a file as bytes. */
  readFile(path: string): Promise<Uint8Array>
  /**
   * Absolute path for an export. An absolute `suggestedName` is used as is; a relative one is placed in
   * `dir` (default ~/ChiptuneStudio/exports; a relative `dir` is relative to that default).
   */
  resolveExportPath(suggestedName: string, dir?: string): Promise<string>
  /** Like resolveExportPath, but the default folder is ~/ChiptuneStudio/projects. */
  resolveProjectPath(suggestedName: string, dir?: string): Promise<string>
  /** Rendering and playback. In the app: a render Worker + the AudioWorklet; in tests: renderSong in-process. */
  audio: AudioService
  /** The asset library (songs, motifs, instruments). Absent where there is no library. */
  assets?: AssetService
}

export interface AudioRenderOptions {
  sampleRate?: 44100 | 48000
  /** Loop bodies after the intro (default 1). */
  loops?: number
  fadeOutSec?: number
  stems?: boolean
}

export interface AudioRenderResult {
  sampleRate: number
  L: Float32Array
  R: Float32Array
  stems?: Record<string, { L: Float32Array; R: Float32Array }>
  /** Sample indices (end exclusive); null for one-shot or faded renders. */
  loopStart: number | null
  loopEnd: number | null
}

export interface PlaybackPosition {
  playing: boolean
  order: number
  row: number
  seconds: number
}

export interface AudioService {
  /** Offline render of a song snapshot (the song is cloned/serialised by the implementation). */
  render(song: Song, opts?: AudioRenderOptions): Promise<AudioRenderResult>
  /** Start playback of the live song, optionally from an order/row (default: the cursor). */
  play(from?: { order: number; row?: number }, opts?: { loop?: boolean }): Promise<void>
  stop(): Promise<void>
  position(): Promise<PlaybackPosition>
}
