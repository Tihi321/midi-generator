// The S-DSP 4-point Gaussian interpolation table (512 entries) and the interpolator.
//
// The hardware table is a half bell: G[0] = 0 rising to G[511] ~ 1305; the four taps for a fractional position
// g (0..255) are G[255-g], G[511-g], G[256+g] and G[g], applied to the oldest..newest of four consecutive
// samples, and the table is built so that the four taps always add up to 2048 (unity DC gain after >> 11).
// Entries 0..415 are the hardware values; entries 416..511 are recomputed from that unity-gain identity
// (G[511-g] = 2048 - G[g] - G[255-g] - G[256+g]), which reproduces the tail to within one LSB.

const LOW = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2,
  2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5,
  6, 6, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 9, 10, 10, 10,
  11, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 16, 16, 17, 17,
  18, 19, 19, 20, 20, 21, 21, 22, 23, 23, 24, 24, 25, 26, 27, 27,
  28, 29, 29, 30, 31, 32, 32, 33, 34, 35, 36, 36, 37, 38, 39, 40,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
  58, 59, 60, 61, 62, 64, 65, 66, 67, 69, 70, 71, 73, 74, 76, 77,
  78, 80, 81, 83, 84, 86, 87, 89, 90, 92, 94, 95, 97, 99, 100, 102,
  104, 106, 107, 109, 111, 113, 115, 117, 118, 120, 122, 124, 126, 128, 130, 132,
  134, 137, 139, 141, 143, 145, 147, 150, 152, 154, 156, 159, 161, 163, 166, 168,
  171, 173, 175, 178, 180, 183, 186, 188, 191, 193, 196, 199, 201, 204, 207, 210,
  212, 215, 218, 221, 224, 227, 230, 233, 236, 239, 242, 245, 248, 251, 254, 257,
  260, 263, 267, 270, 273, 276, 280, 283, 286, 290, 293, 297, 300, 304, 307, 311,
  314, 318, 321, 325, 328, 332, 336, 339, 343, 347, 351, 354, 358, 362, 366, 370
]

const MID = [
  374, 378, 381, 385, 389, 393, 397, 401, 405, 410, 414, 418, 422, 426, 430, 434,
  439, 443, 447, 451, 456, 460, 464, 469, 473, 477, 482, 486, 491, 495, 499, 504,
  508, 513, 517, 522, 527, 531, 536, 540, 545, 550, 554, 559, 563, 568, 573, 577,
  582, 587, 592, 596, 601, 606, 611, 615, 620, 625, 630, 635, 640, 644, 649, 654,
  659, 664, 669, 674, 678, 683, 688, 693, 698, 703, 708, 713, 718, 722, 727, 732,
  737, 742, 747, 752, 757, 762, 767, 772, 777, 782, 787, 792, 797, 802, 806, 811,
  816, 821, 826, 831, 836, 841, 846, 851, 855, 860, 865, 870, 875, 880, 884, 889,
  894, 899, 904, 908, 913, 918, 923, 927, 932, 937, 941, 946, 951, 955, 960, 965,
  969, 974, 978, 983, 988, 992, 997, 1001, 1005, 1010, 1014, 1019, 1023, 1027, 1032, 1036,
  1040, 1045, 1049, 1053, 1057, 1061, 1066, 1070, 1074, 1078, 1082, 1086, 1090, 1093, 1097, 1101
]

function buildTable(): Int16Array {
  const t = new Int16Array(512)
  for (let i = 0; i < 256; i++) t[i] = LOW[i]!
  for (let i = 0; i < MID.length; i++) t[256 + i] = MID[i]!
  for (let g = 0; g < 96; g++) t[511 - g] = 2048 - t[g]! - t[255 - g]! - t[256 + g]!
  return t
}

/** The 512-entry Gaussian table. */
export const GAUSS: Int16Array = buildTable()

/**
 * Interpolate between s1 and s2 (s0 oldest, s3 newest) at fractional position g = 0..255 (frac12 >> 4).
 * Result is in the same units as the samples (float; the hardware shifts by 11).
 */
export function gaussInterpolate(s0: number, s1: number, s2: number, s3: number, g: number): number {
  return (GAUSS[255 - g]! * s0 + GAUSS[511 - g]! * s1 + GAUSS[256 + g]! * s2 + GAUSS[g]! * s3) / 2048
}
