// Sample generation for the SNES sample bank, NES DPCM and the Genesis DAC.
export { GAUSS, gaussInterpolate } from './gauss'
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
  prepareDpcm,
  processForSnes,
  recipeIds,
  resolveSampleSlot,
  resolveSlot,
  sampleByteSize,
  sampleSizes,
  tryPeekSampleLength,
  tryResolveSampleSlot,
  type DpcmEncoded,
  type ParamSpec,
  type ParamValue,
  type RecipeInfo,
  type RecipeParams,
  type SampleResult,
  type SampleTarget
} from './bank'
