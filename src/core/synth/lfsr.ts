// Linear feedback shift registers of the supported chips. All are deterministic (fixed seeds).

/** NES 2A03 noise: 15-bit, feedback = bit0 XOR (short ? bit6 : bit1). Output is high while bit0 == 0. */
export class NesLfsr {
  reg = 1
  short = false
  reset(seed = 1): void {
    this.reg = seed & 0x7fff || 1
  }
  clock(): void {
    const fb = (this.reg & 1) ^ ((this.reg >> (this.short ? 6 : 1)) & 1)
    this.reg = (this.reg >> 1) | (fb << 14)
  }
  /** 1 when the channel outputs its volume. */
  get out(): number {
    return (this.reg & 1) ^ 1
  }
}

/** Game Boy DMG noise: 15-bit, feedback = bit0 XOR bit1 into bit14 (and bit6 in 7-bit mode). */
export class GbLfsr {
  reg = 0x7fff
  width7 = false
  reset(seed = 0x7fff): void {
    this.reg = seed & 0x7fff || 0x7fff
  }
  clock(): void {
    const x = (this.reg & 1) ^ ((this.reg >> 1) & 1)
    this.reg = (this.reg >> 1) | (x << 14)
    if (this.width7) this.reg = (this.reg & ~0x40) | (x << 6)
  }
  get out(): number {
    return (this.reg & 1) ^ 1
  }
}

/**
 * SN76489 noise as in the Sega VDP PSG: 16-bit, reset to 0x8000, white = feedback bit0 XOR bit3 into bit15
 * (mask 0x0009), periodic = bit0 only (cycle of 16). The white polynomial is not maximal-length: from the
 * 0x8000 seed it repeats every 57337 steps, which is what the hardware does too.
 */
export class Sn76489Lfsr {
  reg = 0x8000
  white = true
  reset(seed = 0x8000): void {
    this.reg = seed & 0xffff || 0x8000
  }
  clock(): void {
    const fb = this.white ? (this.reg & 1) ^ ((this.reg >> 3) & 1) : this.reg & 1
    this.reg = (this.reg >> 1) | (fb << 15)
  }
  get out(): number {
    return this.reg & 1
  }
}

/** Measures the cycle length of a register: clocks until the state first returns to its initial value. */
export function lfsrPeriod(reg: { reg: number; clock(): void }, limit = 1 << 17): number {
  const start = reg.reg
  for (let i = 1; i <= limit; i++) {
    reg.clock()
    if (reg.reg === start) return i
  }
  return -1
}
