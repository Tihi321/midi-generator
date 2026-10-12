// SNES echo helpers for the UI: FIR filter presets. Pure.

/** FIR presets: tap 0 is the oldest of the 8 echo samples, tap 7 the newest (a lone 1 on tap 7 = no filtering). */
export const SNES_FIR_PRESETS: Record<string, number[]> = {
  none: [0, 0, 0, 0, 0, 0, 0, 1],
  lowpass: [0.05, 0.1, 0.15, 0.2, 0.2, 0.15, 0.1, 0.05],
  highpass: [0, 0, 0, 0, 0, 0, -0.5, 1],
  band: [0.03, -0.13, -0.25, 0.31, 0.31, -0.25, -0.13, 0.03]
}

/** Name of the preset a FIR matches (within rounding), or 'custom'. */
export function firPresetName(fir: readonly number[]): string {
  for (const [name, taps] of Object.entries(SNES_FIR_PRESETS)) {
    if (taps.length === fir.length && taps.every((t, i) => Math.abs(t - fir[i]!) < 1e-6)) return name
  }
  return 'custom'
}
