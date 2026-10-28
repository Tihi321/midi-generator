import { z } from 'zod'
import {
  type Instrument,
  type RecipeInfo,
  type SampleResult,
  type SampleSlot,
  type Song,
  aicaByteSize,
  aicaRamUsage,
  aicaTargetFor,
  brrByteSize,
  createSampleCommand,
  generateSample,
  getRecipe,
  instSampleId,
  instrumentSlug,
  listRecipes,
  normalizeRecipeParams,
  peekSampleLength,
  psxByteSize,
  resolveSlot,
  snesAramUsage,
  spuRamUsage,
  tryPeekSampleLength
} from '../../core'
import { defineTool } from '../registry'
import { obj, ok, plural, songSession } from '../util'

function paramText(r: RecipeInfo): string {
  return r.params
    .map((p) => {
      const range = p.type === 'number' ? ` ${p.min}..${p.max}` : p.type === 'enum' ? ` ${p.options!.join('|')}` : ''
      return `${p.key}${range} (default ${String(p.default)})`
    })
    .join('; ')
}

function usedBy(song: Song, id: string): string[] {
  return song.instruments.flatMap((i: Instrument, n) => (instSampleId(i) === id ? [`@${n} ${i.name}`] : []))
}

/** "N samples, ~B <codec> bytes" of a slot on the song's chip (PS1: PS-X ADPCM; Dreamcast: PCM16 and ADPCM; the others: BRR). */
function sizeText(chip: Song['chip'], s: SampleSlot): string {
  if (chip === 'ps1') {
    const len = tryPeekSampleLength(s, 'psx') ?? 8192
    return `${len} samples, ~${psxByteSize(len)} PS-X ADPCM bytes`
  }
  if (chip === 'dreamcast') {
    const len = tryPeekSampleLength(s, aicaTargetFor('pcm16')) ?? 8192
    const adpcm = tryPeekSampleLength(s, aicaTargetFor('adpcm')) ?? len
    return `${len} samples, ~${aicaByteSize('pcm16', len)} bytes as pcm16 (~${aicaByteSize('adpcm', adpcm)} as adpcm)`
  }
  const len = peekSampleLength(s)
  return `${len} samples, ~${brrByteSize(len)} BRR bytes`
}

function slotLine(song: Song, s: SampleSlot): string {
  const src =
    s.source.kind === 'recipe'
      ? `recipe ${s.source.recipe}${Object.keys(s.source.params).length ? ' ' + JSON.stringify(s.source.params) : ''}`
      : `user PCM ${s.source.sampleRate} Hz`
  const users = usedBy(song, s.id)
  return `${s.id} "${s.name}": ${src}; ${sizeText(song.chip, s)}${s.loopStart !== undefined ? `, loop from ${s.loopStart}` : ''}; used by ${users.length ? users.join(', ') : 'no instrument'}`
}

/** The RAM budget line of the sample chips with a memory limit (SNES ARAM, PS1 SPU RAM, Dreamcast AICA RAM), or undefined. */
function ramLine(song: Song, mode: 'list' | 'added', addedBytes = 0): string | undefined {
  if (song.chip === 'snes') {
    const u = snesAramUsage(song)
    return mode === 'list'
      ? `ARAM: ~${u.total} of ${u.budget} bytes used by samples that instruments play (${u.sampleBytes} sample + ${u.echoBytes} echo buffer); free ~${u.budget - u.total}.`
      : `ARAM: ~${u.total} of ${u.budget} bytes in use by instruments (this sample adds ~${addedBytes} once an instrument plays it).`
  }
  if (song.chip === 'ps1') {
    const u = spuRamUsage(song)
    const preset = song.chipConfig.chip === 'ps1' ? song.chipConfig.reverb.preset : 'off'
    return mode === 'list'
      ? `SPU RAM: ~${u.total} of ${u.budget} bytes used by samples that instruments play (${u.sampleBytes} ADPCM + ${u.reverbBytes} reverb work area of "${preset}" + ${u.reservedBytes} reserved); free ~${u.budget - u.total}.`
      : `SPU RAM: ~${u.total} of ${u.budget} bytes in use by instruments (this sample adds ~${addedBytes} once an instrument plays it).`
  }
  if (song.chip === 'dreamcast') {
    const u = aicaRamUsage(song)
    const preset = song.chipConfig.chip === 'dreamcast' ? song.chipConfig.dsp.preset : 'off'
    return mode === 'list'
      ? `AICA RAM: ~${u.total} of ${u.budget} bytes used by samples that instruments play (${u.sampleBytes} samples + ${u.dspBytes} DSP buffer of "${preset}"); free ~${u.budget - u.total}.`
      : `AICA RAM: ~${u.total} of ${u.budget} bytes in use by instruments (this sample adds ~${addedBytes} as pcm16, a quarter as adpcm, once an instrument plays it).`
  }
  return undefined
}

/** The sample as the song's chip plays it: SNES pipeline by default, PS-X ADPCM on PS1, PCM16 on Dreamcast. */
function chipSample(chip: Song['chip'], slot: SampleSlot, snes: SampleResult): SampleResult {
  if (chip === 'ps1') return resolveSlot(slot, 'psx')
  if (chip === 'dreamcast') return resolveSlot(slot, aicaTargetFor('pcm16'))
  return snes
}

/** The add_instrument call that plays a sample on the song's chip. */
function addInstrumentHint(chip: Song['chip'], name: string, id: string, baseNote: number): string {
  const head = `"name":"${name}","sample":"${id}","baseNote":${baseNote}`
  if (chip === 'snes') return `add_instrument {"params":{"kind":"snes-sample",${head},"env":{"adsr":[15,7,7,0]},"echo":true}}`
  if (chip === 'ps1') return `add_instrument {"params":{"kind":"psx-sample",${head},"adsr":{"attack":27,"attackExp":false,"decay":13,"sustainLevel":15,"sustainRate":127,"sustainDir":"dec","sustainExp":true,"release":12,"releaseExp":true},"reverb":true}}`
  if (chip === 'dreamcast') return `add_instrument {"params":{"kind":"aica-sample",${head},"format":"pcm16","aeg":{"ar":22,"d1r":0,"d2r":0,"rr":12,"dl":0},"send":8}}`
  return `add_instrument {"params":{"kind":"sample",${head}}}`
}

export const sampleTools = [
  defineTool({
    name: 'list_samples',
    group: 'instruments',
    readOnly: true,
    description:
      'List the sample slots of the song (id, source, length, size in bytes on the song\'s chip: BRR on SNES, PS-X ADPCM on PS1, PCM16 / ADPCM on Dreamcast; which instruments use them; and the memory budget on SNES (ARAM), PS1 (SPU RAM) and Dreamcast (AICA RAM)) and the sample recipes generate_sample can create with their parameters, including the synth recipes (supersaw, sawlead, syncsaw, junopad, analogbass, fmbass, synthpluck, synthbrass, dxepiano, dxbell, linnkick, 808kick, linnsnare, gatedsnare, linnclap, linnhat, linnopenhat, linntom, linncrash). Pass "recipe" for the details of one recipe. Samples feed SNES instruments (snes-sample), PS1 instruments (psx-sample), Dreamcast instruments (aica-sample), the Genesis F6 DAC and the NES DPCM channel (sample). Presets add the samples they need automatically.',
    input: obj({ recipe: z.string().optional().describe('Show only this recipe with all its parameters (e.g. "strings", "kick").') }),
    handler: (args, ctx) => {
      const song = songSession(ctx).song
      if (args.recipe) {
        const r = getRecipe(args.recipe)
        if (!r) throw new Error(`Unknown sample recipe "${args.recipe}". Recipes: ${listRecipes().map((x) => x.id).join(', ')}.`)
        const g = generateSample(r.id)
        const probe: SampleSlot = { id: r.id, name: r.label, source: { kind: 'recipe', recipe: r.id, params: {} } }
        const cs = chipSample(song.chip, probe, g)
        const size = song.chip === 'ps1' ? `~${psxByteSize(cs.pcm.length)} PS-X ADPCM bytes` : song.chip === 'dreamcast' ? `~${aicaByteSize('pcm16', cs.pcm.length)} bytes as pcm16` : `~${g.brrBytes} BRR bytes`
        return ok(`Recipe ${r.id} (${r.label}, role ${r.role}, ${r.loops ? 'looping' : 'one-shot'}): ${r.description}\nParameters: ${paramText(r)}.\nDefault: base note ${cs.baseNote}, ${cs.pcm.length} samples at ${cs.sampleRate} Hz, ${size}.\nUse generate_sample {"recipe":"${r.id}","params":{...},"name":"..."} and then add_instrument with the new sample id.`)
      }
      const lines: string[] = []
      if (song.samples.length === 0) lines.push('Sample slots: none yet (presets add theirs; generate_sample adds one).')
      else lines.push(`Sample slots (${song.samples.length}):`, ...song.samples.map((s) => slotLine(song, s)))
      const ram = ramLine(song, 'list')
      if (ram) lines.push(ram)
      lines.push('', `Recipes (${listRecipes().length}); list_samples {"recipe":"<id>"} shows the parameters:`)
      for (const r of listRecipes()) lines.push(`${r.id} (${r.role}, ${r.loops ? 'loop' : 'one-shot'}): ${r.description}`)
      return ok(lines.join('\n'))
    }
  }),

  defineTool({
    name: 'generate_sample',
    group: 'instruments',
    description:
      'Generate a sample from a recipe (strings, choir, organ, flute, brass, pad, bass, lead, harp, pluck, guitar, koto, bell, epiano, kick, snare, hat, openhat, crash, tom, clap, and the synth recipes supersaw, sawlead, syncsaw, junopad, analogbass, fmbass, synthpluck, synthbrass, dxepiano, dxbell, linnkick, 808kick, linnsnare, gatedsnare, linnclap, linnhat, linnopenhat, linntom, linncrash) and add it to the song as a sample slot. Parameters depend on the recipe (list_samples {"recipe":"strings"}); seeds make noisy sounds reproducible. Returns the sample id, its size on the song\'s chip and the add_instrument call that plays it: SNES uses kind "snes-sample" (env, echo), PS1 "psx-sample" (adsr, reverb), Dreamcast "aica-sample" (format, aeg, send), the Genesis F6 DAC and the NES DPCM channel use kind "sample". One undo step. Example: {"recipe":"strings","params":{"bright":0.8},"name":"bright strings"}.',
    input: obj({
      recipe: z.string().min(1).describe('Recipe id (list_samples shows them).'),
      params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional().describe('Recipe parameters, e.g. {"note":57,"seconds":0.4}.'),
      name: z.string().min(1).optional().describe('Sample name (default: the recipe name). The sample id is made from it.')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const r = getRecipe(args.recipe)
      if (!r) throw new Error(`Unknown sample recipe "${args.recipe}". Recipes: ${listRecipes().map((x) => x.id).join(', ')}.`)
      const params = normalizeRecipeParams(r.id, args.params ?? {})
      const name = args.name ?? r.label
      const base = instrumentSlug(name) || r.id
      let id = base
      for (let n = 2; song.samples.some((s) => s.id === id); n++) id = `${base}-${n}`
      const g = generateSample(r.id, params)
      const slot: SampleSlot = { id, name, source: { kind: 'recipe', recipe: r.id, params: { ...params } } }
      session.execute(createSampleCommand(song, { op: 'add', sample: slot }))
      const cs = chipSample(song.chip, slot, g)
      const bytes = song.chip === 'ps1' ? psxByteSize(cs.pcm.length) : song.chip === 'dreamcast' ? aicaByteSize('pcm16', cs.pcm.length) : (g.brrBytes ?? brrByteSize(g.pcm.length))
      const codec = song.chip === 'ps1' ? 'PS-X ADPCM' : song.chip === 'dreamcast' ? 'pcm16' : 'BRR'
      const ram = ramLine(song, 'added', bytes)
      const how = addInstrumentHint(song.chip, instrumentSlug(name) || r.id, id, cs.baseNote)
      return ok(
        `Added sample "${id}" (${r.id}${r.loops ? ', looping' : ', one-shot'}): ${plural(cs.pcm.length, 'sample')} at ${cs.sampleRate} Hz, ~${bytes} ${codec} bytes, base note ${cs.baseNote}${cs.loopStart !== undefined ? `, loop from ${cs.loopStart}` : ''}.${ram ? '\n' + ram : ''}\nPlay it with ${how}.`
      )
    }
  })
]
