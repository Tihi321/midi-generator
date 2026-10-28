// PlayStation SPU voices (Phase B): 16 or 24 PS-X ADPCM sample voices on the shared sampler core, PS1 ADSR, pitch
// modulation, noise and the SPU reverb bus (`_reverb` stem).
//
// Phase B0 scaffolding: the 'ps1' sample channels are registered with a SilentVoice and a default mix profile. Phase B
// replaces the factory below with `SpuVoice extends SamplerVoice<PsxSampleInstrument>` plus its reverb bus, tunes the
// mix profile and calls `markChipPlayable('ps1')`; until then the tools refuse to render the chip.

import { registerMixProfile } from '../mixer'
import { SilentVoice, registerVoice } from './types'
import '../samplegen/psxAdpcm' // registers the 'psx' sample target

registerVoice('ps1', 'sample', () => new SilentVoice())

registerMixProfile('ps1', {
  outputGain: 1,
  filters: () => []
})
