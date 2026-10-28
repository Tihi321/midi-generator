// Sample generation for the SNES sample bank, NES DPCM and the Genesis DAC.
export { GAUSS, gaussInterpolate } from './gauss'
// the PS1 and Dreamcast sample targets register themselves when their modules load
export { PSX_BLOCK_BYTES, PSX_BLOCK_SAMPLES, processForPsx, processUserPcmForPsx, psxByteSize } from './psxAdpcm'
export { aicaByteSize, aicaTargetFor, processForAica16, processForAica8, processForAicaAdpcm, type AicaFormat } from './aicaAdpcm'
export { BRR_BLOCK_BYTES, BRR_BLOCK_SAMPLES, brrByteSize, brrRoundTrip, decodeBrr, encodeBrr, snrDb, type BrrDecoded, type BrrEncodeOptions, type BrrEncoded } from './brr'
export { Rng, hashSeed, type RawSample } from './generators'
export {
  DPCM_PERIODS_NTSC,
  DPCM_PERIODS_PAL,
  DPCM_START_LEVEL,
  clearSampleCache,
  dacQuantize,
  decodeDpcm,
  dpcmRates,
  encodeDpcm,
  generateRaw,
  generateSample,
  getRecipe,
  listRecipes,
  normalizeRecipeParams,
  pcmToBase64,
  peekSampleLength,
  getSampleTarget,
  prepareDpcm,
  processForSnes,
  recipeIds,
  registerSampleTarget,
  resolveSampleSlot,
  resolveSlot,
  sampleByteSize,
  sampleSizes,
  sampleTargetBytes,
  tryPeekSampleLength,
  tryResolveSampleSlot,
  type DpcmEncoded,
  type ParamSpec,
  type ParamValue,
  type RecipeInfo,
  type RecipeParams,
  type SampleResult,
  type SampleTarget,
  type SampleTargetDef
} from './bank'
