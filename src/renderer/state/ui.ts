// UI-only state (dialogs, tabs, tracker cursor column and selection, playhead, mute/solo, piano-roll view).
// The song itself lives in the session (state/session.ts); the playhead lives here so it never touches the
// undo history.

import { create } from 'zustand'
import type { Clip, GridPoint } from '../lib/trackerGrid'

export type DialogId = null | 'settings' | 'new' | 'open' | 'save' | 'export' | 'saveAsset'
export type CenterTab = 'tracker' | 'piano'
export type PanelTab = 'instruments' | 'library' | 'chat'

export interface Playhead {
  playing: boolean
  order: number
  row: number
  seconds: number
}

export interface UiData {
  dialog: DialogId
  centerTab: CenterTab
  /** Right column: instruments, the library or the agent chat. */
  panelTab: PanelTab

  // tracker
  /** Field index inside the cursor's channel (note, inst hi/lo, vol, fx...). */
  field: number
  /** Selection anchor (the other corner is the cursor); null = no selection. */
  anchor: GridPoint | null
  /** In-app clipboard for tracker cells. */
  clip: Clip | null
  /** Rows the cursor moves down after an entry. */
  editStep: number
  /** First hex digit of a two-digit entry (instrument / effect parameter), waiting for the second. */
  pendingNibble: number | null
  /** Scroll/show the playing order and row while playing. */
  follow: boolean

  // playback
  playhead: Playhead
  loop: boolean
  volume: number
  /** Player-level mute per channel index (does not change the song). */
  mutes: Record<number, boolean>
  /** Solo channel index, or null. */
  solo: number | null

  // piano roll
  /** Channel shown (and edited), or every channel. */
  rollChannel: number | 'all'
  rollSelected: { channel: number; start: number } | null
  /** Length in rows of a note created by a plain click. */
  rollLen: number

  // misc
  /** Preset of the Save to library dialog (set when it opens). */
  assetDraft: { kind: 'song' | 'motif' | 'instrument'; instrument: number } | null
  status: string
  projectPath: string | null
  /** Selected instrument in the Instruments panel list filter (preset chooser). */
  presetRole: string
}

export interface UiState extends UiData {
  openDialog: (d: DialogId) => void
  set: (patch: Partial<UiData>) => void
  setStatus: (msg: string) => void
  setPlayhead: (p: Playhead) => void
}

export const useUi = create<UiState>((set) => ({
  dialog: null,
  centerTab: 'tracker',
  panelTab: 'instruments',
  field: 0,
  anchor: null,
  clip: null,
  editStep: 1,
  pendingNibble: null,
  follow: true,
  playhead: { playing: false, order: 0, row: 0, seconds: 0 },
  loop: true,
  volume: 0.8,
  mutes: {},
  solo: null,
  rollChannel: 'all',
  rollSelected: null,
  rollLen: 2,
  assetDraft: null,
  status: '',
  projectPath: null,
  presetRole: '',
  openDialog: (dialog) => set({ dialog }),
  set: (patch) => set(patch),
  setStatus: (status) => set({ status }),
  setPlayhead: (playhead) => set({ playhead })
}))
