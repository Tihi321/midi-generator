// The tool definitions of Chiptune Studio, grouped like the plan's tool table.
// Phase 4/5 adds: convert_chip (song), export_midi / import_midi (export), list_samples / generate_sample
// (instruments), and the library tools list_assets / get_asset / save_as_asset / place_asset /
// set_style_reference / get_style_context (assets).

import { type RegisteredTool, ToolRegistry } from '../registry'
import { assetTools } from './assets'
import { channelTools } from './channels'
import { exportTools } from './export'
import { historyTools } from './history'
import { instrumentTools } from './instruments'
import { midiTools } from './midi'
import { noteTools } from './notes'
import { orderTools } from './order'
import { playbackTools } from './playback'
import { readingTools } from './reading'
import { sampleTools } from './samples'
import { songTools } from './song'
import { theoryTools } from './theory'

export { assetTools, channelTools, exportTools, historyTools, instrumentTools, midiTools, noteTools, orderTools, playbackTools, readingTools, sampleTools, songTools, theoryTools }

export function allTools(): RegisteredTool[] {
  return [
    ...songTools,
    ...channelTools,
    ...orderTools,
    ...noteTools,
    ...readingTools,
    ...instrumentTools,
    ...sampleTools,
    ...theoryTools,
    ...assetTools,
    ...exportTools,
    ...midiTools,
    ...playbackTools,
    ...historyTools
  ]
}

/** A registry with every tool registered. */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry(allTools())
}
