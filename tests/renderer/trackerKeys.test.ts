import { describe, expect, it } from 'vitest'
import { NOTE_KEYS, type KeyInfo, noteForKey, trackerKeyAction } from '../../src/renderer/lib/trackerKeys'

const key = (code: string, extra: Partial<KeyInfo> = {}): KeyInfo => ({ key: extra.key ?? code.replace(/^(Key|Digit)/, '').toLowerCase(), code, ...extra })

describe('piano key layout', () => {
  it('maps the bottom row to the current octave (Z = C, M = B)', () => {
    const names = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM']
    expect(names.map((c) => noteForKey(c, 4))).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71])
  })

  it('maps the top row one octave higher (Q = C, U = B) and continues with I 9 O 0 P', () => {
    const names = ['KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU']
    expect(names.map((c) => noteForKey(c, 4))).toEqual([72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83])
    expect(noteForKey('KeyI', 4)).toBe(84)
    expect(noteForKey('KeyP', 4)).toBe(88)
  })

  it('follows the octave and returns null for non-piano keys and out-of-range notes', () => {
    expect(noteForKey('KeyZ', 2)).toBe(36)
    expect(noteForKey('KeyA', 4)).toBeNull()
    expect(noteForKey('KeyP', 9)).toBeNull() // E-10 does not exist
    expect(Object.keys(NOTE_KEYS)).toHaveLength(29)
  })
})

describe('trackerKeyAction', () => {
  it('turns piano keys into notes only in the note field', () => {
    expect(trackerKeyAction(key('KeyZ'), 'note', 4)).toEqual({ type: 'note', midi: 60 })
    expect(trackerKeyAction(key('KeyQ'), 'note', 3)).toEqual({ type: 'note', midi: 60 })
    expect(trackerKeyAction(key('KeyZ'), 'vol', 4)).toBeNull()
  })

  it('does not retrigger notes on key repeat', () => {
    expect(trackerKeyAction(key('KeyZ', { repeat: true }), 'note', 4)).toBeNull()
  })

  it('maps note off and release keys', () => {
    expect(trackerKeyAction(key('Digit1', { key: '1' }), 'note', 4)).toEqual({ type: 'noteOff' })
    expect(trackerKeyAction(key('Backslash', { key: '\\' }), 'note', 4)).toEqual({ type: 'noteOff' })
    expect(trackerKeyAction(key('Backquote', { key: '`' }), 'note', 4)).toEqual({ type: 'release' })
  })

  it('reads hex digits in instrument, volume and effect fields', () => {
    expect(trackerKeyAction(key('KeyA', { key: 'a' }), 'inst0', 4)).toEqual({ type: 'hex', digit: 10 })
    expect(trackerKeyAction(key('Digit7', { key: '7' }), 'vol', 4)).toEqual({ type: 'hex', digit: 7 })
    expect(trackerKeyAction(key('KeyG', { key: 'g' }), 'fxhi', 4)).toBeNull()
  })

  it('reads effect letters and digits in the effect code field', () => {
    expect(trackerKeyAction(key('KeyW', { key: 'w' }), 'fxcode', 4)).toEqual({ type: 'fxCode', code: 'W' })
    expect(trackerKeyAction(key('Digit4', { key: '4' }), 'fxcode', 4)).toEqual({ type: 'fxCode', code: '4' })
    expect(trackerKeyAction(key('KeyZ', { key: 'z' }), 'fxcode', 4)).toBeNull()
  })

  it('maps clear keys, navigation and selection extension', () => {
    expect(trackerKeyAction(key('Delete', { key: 'Delete' }), 'note', 4)).toEqual({ type: 'clear' })
    expect(trackerKeyAction(key('Period', { key: '.' }), 'note', 4)).toEqual({ type: 'clear' })
    expect(trackerKeyAction(key('ArrowDown', { key: 'ArrowDown' }), 'note', 4)).toEqual({ type: 'move', key: 'down', extend: false })
    expect(trackerKeyAction(key('ArrowDown', { key: 'ArrowDown', shift: true }), 'note', 4)).toEqual({ type: 'move', key: 'down', extend: true })
    expect(trackerKeyAction(key('Tab', { key: 'Tab' }), 'note', 4)).toEqual({ type: 'move', key: 'tabNext', extend: false })
    expect(trackerKeyAction(key('Tab', { key: 'Tab', shift: true }), 'note', 4)).toEqual({ type: 'move', key: 'tabPrev', extend: false })
  })

  it('maps octave, transport and clipboard shortcuts', () => {
    expect(trackerKeyAction(key('NumpadAdd', { key: '+' }), 'note', 4)).toEqual({ type: 'octave', delta: 1 })
    expect(trackerKeyAction(key('NumpadSubtract', { key: '-' }), 'note', 4)).toEqual({ type: 'octave', delta: -1 })
    expect(trackerKeyAction(key('Space', { key: ' ' }), 'vol', 4)).toEqual({ type: 'playToggle' })
    expect(trackerKeyAction(key('KeyZ', { ctrl: true }), 'note', 4)).toEqual({ type: 'undo' })
    expect(trackerKeyAction(key('KeyZ', { ctrl: true, shift: true }), 'note', 4)).toEqual({ type: 'redo' })
    expect(trackerKeyAction(key('KeyY', { ctrl: true }), 'note', 4)).toEqual({ type: 'redo' })
    expect(trackerKeyAction(key('KeyC', { ctrl: true }), 'note', 4)).toEqual({ type: 'copy' })
    expect(trackerKeyAction(key('KeyX', { ctrl: true }), 'note', 4)).toEqual({ type: 'cut' })
    expect(trackerKeyAction(key('KeyV', { ctrl: true }), 'note', 4)).toEqual({ type: 'paste' })
  })

  it('transposes with Ctrl+Up/Down (semitone) and Ctrl+Shift (octave)', () => {
    expect(trackerKeyAction(key('ArrowUp', { key: 'ArrowUp', ctrl: true }), 'note', 4)).toEqual({ type: 'transpose', semitones: 1 })
    expect(trackerKeyAction(key('ArrowDown', { key: 'ArrowDown', ctrl: true }), 'note', 4)).toEqual({ type: 'transpose', semitones: -1 })
    expect(trackerKeyAction(key('ArrowUp', { key: 'ArrowUp', ctrl: true, shift: true }), 'note', 4)).toEqual({ type: 'transpose', semitones: 12 })
    expect(trackerKeyAction(key('ArrowDown', { key: 'ArrowDown', ctrl: true, shift: true }), 'note', 4)).toEqual({ type: 'transpose', semitones: -12 })
  })

  it('ignores unrelated Ctrl/Alt combinations so the browser keeps them', () => {
    expect(trackerKeyAction(key('KeyR', { ctrl: true }), 'note', 4)).toBeNull()
    expect(trackerKeyAction(key('KeyZ', { alt: true }), 'note', 4)).toBeNull()
    expect(trackerKeyAction(key('F5', { key: 'F5' }), 'note', 4)).toBeNull()
  })
})
