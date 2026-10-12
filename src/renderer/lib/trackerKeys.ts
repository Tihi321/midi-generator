// Keyboard mapping for the tracker (FamiTracker layout). Pure: takes a plain key description (not a DOM
// event), so it can be unit-tested in Node.

import type { EffectCode } from '../../core'
import { type FieldKind, type NavKey, isEffectCode } from './trackerGrid'

export interface KeyInfo {
  /** KeyboardEvent.key */
  key: string
  /** KeyboardEvent.code (physical key; used for the piano layout so it works on any keyboard layout). */
  code: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
  repeat?: boolean
}

/**
 * Piano layout: physical key -> semitones above C of the current octave. The bottom row (Z S X D C V G B H N J M)
 * is the current octave, the top row (Q 2 W 3 E R 5 T 6 Y 7 U, then I 9 O 0 P) starts one octave higher.
 */
export const NOTE_KEYS: Readonly<Record<string, number>> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28
}

/** MIDI note of a piano key at tracker octave `octave` (C-4 = 60), or null when the key is not a piano key. */
export function noteForKey(code: string, octave: number): number | null {
  const off = NOTE_KEYS[code]
  if (off === undefined) return null
  const midi = (octave + 1) * 12 + off
  return midi >= 12 && midi <= 127 ? midi : null
}

export type TrackerAction =
  | { type: 'note'; midi: number }
  | { type: 'noteOff' }
  | { type: 'release' }
  | { type: 'hex'; digit: number }
  | { type: 'fxCode'; code: EffectCode }
  | { type: 'clear' }
  | { type: 'move'; key: NavKey; extend: boolean }
  | { type: 'octave'; delta: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'copy' }
  | { type: 'cut' }
  | { type: 'paste' }
  | { type: 'selectAll' }
  | { type: 'transpose'; semitones: number }
  | { type: 'playToggle' }
  | { type: 'escape' }

const NAV: Readonly<Record<string, NavKey>> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', PageUp: 'pageUp', PageDown: 'pageDown', Home: 'home', End: 'end'
}

/**
 * Map a key press to a tracker action for the field under the cursor, or null when the key is not ours.
 * `octave` is the current entry octave.
 */
export function trackerKeyAction(k: KeyInfo, field: FieldKind, octave: number): TrackerAction | null {
  const mod = !!(k.ctrl || k.meta)
  if (mod) {
    if (k.alt) return null
    switch (k.code) {
      case 'KeyZ':
        return k.shift ? { type: 'redo' } : { type: 'undo' }
      case 'KeyY':
        return { type: 'redo' }
      case 'KeyC':
        return { type: 'copy' }
      case 'KeyX':
        return { type: 'cut' }
      case 'KeyV':
        return { type: 'paste' }
      case 'KeyA':
        return { type: 'selectAll' }
      case 'ArrowUp':
        return { type: 'transpose', semitones: k.shift ? 12 : 1 }
      case 'ArrowDown':
        return { type: 'transpose', semitones: k.shift ? -12 : -1 }
      default:
        return null
    }
  }
  if (k.alt) return null

  if (k.code === 'Space') return { type: 'playToggle' }
  if (k.code === 'Escape') return { type: 'escape' }
  if (k.code === 'NumpadAdd') return { type: 'octave', delta: 1 }
  if (k.code === 'NumpadSubtract') return { type: 'octave', delta: -1 }
  if (k.code === 'Tab') return { type: 'move', key: k.shift ? 'tabPrev' : 'tabNext', extend: false }
  const nav = NAV[k.key]
  if (nav) return { type: 'move', key: nav, extend: !!k.shift }
  if (k.key === 'Delete' || k.key === 'Backspace' || k.key === '.') return { type: 'clear' }
  if (k.shift) return null

  if (field === 'note') {
    if (k.code === 'Digit1' || k.code === 'Backslash' || k.code === 'IntlBackslash') return { type: 'noteOff' }
    if (k.code === 'Backquote' || k.code === 'Quote') return { type: 'release' }
    if (k.repeat) return null
    const midi = noteForKey(k.code, octave)
    return midi === null ? null : { type: 'note', midi }
  }
  if (field === 'fxcode') {
    const ch = k.key.length === 1 ? k.key.toUpperCase() : ''
    return isEffectCode(ch) ? { type: 'fxCode', code: ch } : null
  }
  if (/^[0-9a-fA-F]$/.test(k.key)) return { type: 'hex', digit: parseInt(k.key, 16) }
  return null
}

/** True for keys the tracker never uses, so the app can leave them to the browser (F5, Ctrl+R, ...). */
export function isTrackerKey(k: KeyInfo, field: FieldKind, octave: number): boolean {
  return trackerKeyAction(k, field, octave) !== null
}
