// Public synth API.
// midiToHz/hzToMidi: use core/notes (same formula); synth-internal versions stay under `tables`.
export * as tables from './tables'
export { BlipBuffer, BLIP_KERNEL, BLIP_TAPS, BLIP_PHASES } from './blip'
export { NesLfsr, GbLfsr, Sn76489Lfsr, lfsrPeriod } from './lfsr'
export { Sequencer, newChannelControl, type ChannelControl, type SeqPosition } from './sequencer'
export { Timeline, buildTimeline, type TimelineRow, type SampleBoundaries } from './timeline'
export { resolvePatterns, samplesPerTick } from './flow'
export {
  type ChipVoice,
  type MixGroup,
  type VoiceArgs,
  type VoiceFactory,
  registerVoice,
  markChipPlayable,
  isChipPlayable,
  createVoice,
  SilentVoice,
  BlipVoice
} from './chips'
export {
  Mixer,
  Dither,
  softLimit,
  floatToInt16,
  quantizeStereo,
  interleave,
  registerMixProfile,
  mixProfileFor,
  type MixModel,
  type StemBuffer,
  type ChipMixProfile,
  type Filter
} from './mixer'
export { SongPlayer, type PlayerOptions, type PlayerPosition } from './player'
export * from './samplegen'
export { EchoBus, SpcVoice, SNES_RATE_PERIODS } from './chips/spc700'
export { DacVoice, DpcmVoice } from './chips/sample'
export { renderSong, type RenderOptions, type RenderResult, type StemPair } from './render'
