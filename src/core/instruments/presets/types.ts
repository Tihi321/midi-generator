import type { ChannelKind, Instrument, Role, SampleSlot } from '../../types'

export interface Preset {
  /** e.g. "nes.lead.duty25" */
  id: string
  /** Default instrument name (also the `@name` reference; the tool layer makes it unique). */
  name: string
  role: Role
  description: string
  /** Channel kinds the preset can play on. */
  channelKinds: ChannelKind[]
  /** Template; resolvePreset returns a deep copy with presetId/role/gm filled in. */
  instrument: Instrument
  /**
   * Sample slot the instrument plays (sample presets only): a recipe slot whose id is `instrument.sample`.
   * The tool layer / UI add it to the song when the preset is added and the song has no such slot
   * (see `missingPresetSample`).
   */
  sample?: SampleSlot
}
