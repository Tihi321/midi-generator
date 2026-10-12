// Importing this module registers every available chip voice. Add Phase 4 chips here.
import './apu2a03'
import './dmg'
import './huc6280'
import './sn76489'
import './ym2612'
import './spc700'
import './sample'

export * from './types'
export { BlipVoice } from './blipVoice'
export { NesPulseVoice, NesTriangleVoice, NesNoiseVoice } from './apu2a03'
export { GbPulseVoice, GbWaveVoice, GbNoiseVoice } from './dmg'
