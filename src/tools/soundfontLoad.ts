// Make sure the synth has the SoundFont a gm song needs before it is rendered or played. The host's SoundFontService
// (Node: the data folder; app window: IPC to main) supplies the bytes; the synth keeps the parsed bank until they change.
// No DOM, no Electron, no node:*.

import { SOUNDFONT_MISSING_MESSAGE, type Song, hasSoundFont, setSoundFont } from '../core'
import { GM_DEFAULT_SOUNDFONT } from '../core/types'
import type { SoundFontService } from './services'

/** The SoundFont file name a song asks for (chipConfig.soundfont; the default for every other chip). */
export function soundFontFileOf(song: Song): string {
  return song.chipConfig.chip === 'gm' ? song.chipConfig.soundfont : GM_DEFAULT_SOUNDFONT
}

/**
 * For a gm song: load its SoundFont into the synth (no-op for every other chip). With a service the file is read through
 * it (a missing file rejects with the path and download address); without one the synth must already hold a SoundFont.
 */
export async function ensureSoundFontLoaded(service: SoundFontService | undefined, song: Song): Promise<void> {
  if (song.chip !== 'gm') return
  if (!service) {
    if (!hasSoundFont()) throw new Error(SOUNDFONT_MISSING_MESSAGE)
    return
  }
  setSoundFont(await service.load(soundFontFileOf(song)))
}
