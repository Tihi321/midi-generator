// A tiny valid SoundFont 2 built in memory for the gm chip tests (CI has no GeneralUser GS): preset 0 of bank 0 is a looped
// 441 Hz sine, preset 0 of the drum bank (128) is a short decaying thump on every key. Not a real instrument; it proves
// the chip's plumbing (voices, timing, determinism) without a download.

const enc = new TextEncoder()

function u16(v: number): number[] {
  return [v & 255, (v >> 8) & 255]
}
function u32(v: number): number[] {
  return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255]
}
function str(s: string, n: number): number[] {
  const b = Array.from(enc.encode(s)).slice(0, n)
  while (b.length < n) b.push(0)
  return b
}
function chunk(id: string, data: number[]): number[] {
  const body = [...data]
  if (body.length % 2 === 1) body.push(0)
  return [...enc.encode(id), ...u32(data.length), ...body]
}
function list(id: string, parts: number[][]): number[] {
  const inner = [...enc.encode(id), ...parts.flat()]
  return [...enc.encode('LIST'), ...u32(inner.length), ...inner]
}
function s16(v: number): number[] {
  const x = Math.max(-32768, Math.min(32767, Math.round(v)))
  return u16(x < 0 ? x + 65536 : x)
}

export function buildMiniSoundFont(): Uint8Array {
  // sample 0: 100 samples per period sine x 20 periods (looped); sample 1: decaying low sine, one shot
  const tone: number[] = []
  for (let i = 0; i < 2000; i++) tone.push(Math.sin((2 * Math.PI * i) / 100) * 12000)
  const thump: number[] = []
  for (let i = 0; i < 4000; i++) thump.push(Math.sin((2 * Math.PI * i) / 160) * 20000 * Math.exp(-i / 700))
  const pad = new Array<number>(46).fill(0)
  const smpl = [...tone, ...pad, ...thump, ...pad].flatMap(s16)

  const shdr = [
    ...str('tone', 20), ...u32(0), ...u32(2000), ...u32(0), ...u32(2000), ...u32(44100), 69, 0, ...u16(0), ...u16(1),
    ...str('thump', 20), ...u32(2046), ...u32(6046), ...u32(2046), ...u32(2047), ...u32(44100), 60, 0, ...u16(0), ...u16(1),
    ...str('EOS', 20), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), 0, 0, ...u16(0), ...u16(0)
  ]
  const phdr = [
    ...str('Tone', 20), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(0),
    ...str('Thump kit', 20), ...u16(0), ...u16(128), ...u16(1), ...u32(0), ...u32(0), ...u32(0),
    ...str('EOP', 20), ...u16(0), ...u16(0), ...u16(2), ...u32(0), ...u32(0), ...u32(0)
  ]
  const pbag = [...u16(0), ...u16(0), ...u16(1), ...u16(0), ...u16(2), ...u16(0)]
  const pmod = new Array<number>(10).fill(0)
  const pgen = [...u16(41), ...u16(0), ...u16(41), ...u16(1), ...u16(0), ...u16(0)]
  const inst = [...str('tone', 20), ...u16(0), ...str('thump', 20), ...u16(1), ...str('EOI', 20), ...u16(2)]
  const ibag = [...u16(0), ...u16(0), ...u16(2), ...u16(0), ...u16(4), ...u16(0)]
  const imod = new Array<number>(10).fill(0)
  // sampleModes (54): 1 = loop; sampleID (53) ends the zone; the release is 0.3 s (releaseVolEnv 38 = -4000 timecents)
  const igen = [
    ...u16(54), ...u16(1), ...u16(53), ...u16(0),
    ...u16(54), ...u16(0), ...u16(53), ...u16(1),
    ...u16(0), ...u16(0)
  ]
  const info = list('INFO', [chunk('ifil', [...u16(2), ...u16(1)]), chunk('isng', str('EMU8000', 8)), chunk('INAM', str('Mini test font', 16))])
  const sdta = list('sdta', [chunk('smpl', smpl)])
  const pdta = list('pdta', [
    chunk('phdr', phdr), chunk('pbag', pbag), chunk('pmod', pmod), chunk('pgen', pgen),
    chunk('inst', inst), chunk('ibag', ibag), chunk('imod', imod), chunk('igen', igen), chunk('shdr', shdr)
  ])
  const body = [...enc.encode('sfbk'), ...info, ...sdta, ...pdta]
  return new Uint8Array([...enc.encode('RIFF'), ...u32(body.length), ...body])
}
