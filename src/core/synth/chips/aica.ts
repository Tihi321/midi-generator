// Dreamcast AICA voices (Phase C): 16, 32 or 64 PCM16 / PCM8 / ADPCM slots on the shared sampler core, AEG, LFO,
// resonant filter and the DSP bus (`_dsp` stem).
//
// Phase B0 scaffolding: the 'dreamcast' sample channels are registered with a SilentVoice and a default mix profile.
// Phase C replaces the factory below with `AicaVoice extends SamplerVoice<AicaSampleInstrument>` plus its DSP bus,
// tunes the mix profile (and `quantizePan` to the 16 DIPAN steps) and calls `markChipPlayable('dreamcast')`; until
// then the tools refuse to render the chip.

import { registerMixProfile } from '../mixer'
import { SilentVoice, registerVoice } from './types'
import '../samplegen/aicaAdpcm' // registers the 'aica16' / 'aica8' / 'aica-adpcm' sample targets

registerVoice('dreamcast', 'sample', () => new SilentVoice())

registerMixProfile('dreamcast', {
  outputGain: 1,
  filters: () => []
})
