import { z } from 'zod'
import {
  type Instrument,
  type RecipeInfo,
  type SampleSlot,
  type Song,
  brrByteSize,
  createSampleCommand,
  generateSample,
  getRecipe,
  instrumentSlug,
  listRecipes,
  normalizeRecipeParams,
  peekSampleLength,
  snesAramUsage
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
  return song.instruments.flatMap((i: Instrument, n) => ((i.kind === 'snes-sample' || i.kind === 'sample') && i.sample === id ? [`@${n} ${i.name}`] : []))
}

function slotLine(song: Song, s: SampleSlot): string {
  const len = peekSampleLength(s)
  const src =
    s.source.kind === 'recipe'
      ? `recipe ${s.source.recipe}${Object.keys(s.source.params).length ? ' ' + JSON.stringify(s.source.params) : ''}`
      : `user PCM ${s.source.sampleRate} Hz`
  const users = usedBy(song, s.id)
  return `${s.id} "${s.name}": ${src}; ${len} samples, ~${brrByteSize(len)} BRR bytes${s.loopStart !== undefined ? `, loop from ${s.loopStart}` : ''}; used by ${users.length ? users.join(', ') : 'no instrument'}`
}

export const sampleTools = [
  defineTool({
    name: 'list_samples',
    group: 'instruments',
    readOnly: true,
    description:
      'List the sample slots of the song (id, source, length, BRR size in bytes, which instruments use them; on SNES also the ARAM budget) and the sample recipes generate_sample can create with their parameters. Pass "recipe" for the details of one recipe. Samples feed SNES instruments (snes-sample), the Genesis F6 DAC and the NES DPCM channel (sample). Presets add the samples they need automatically.',
    input: obj({ recipe: z.string().optional().describe('Show only this recipe with all its parameters (e.g. "strings", "kick").') }),
    handler: (args, ctx) => {
      const song = songSession(ctx).song
      if (args.recipe) {
        const r = getRecipe(args.recipe)
        if (!r) throw new Error(`Unknown sample recipe "${args.recipe}". Recipes: ${listRecipes().map((x) => x.id).join(', ')}.`)
        const g = generateSample(r.id)
        return ok(`Recipe ${r.id} (${r.label}, role ${r.role}, ${r.loops ? 'looping' : 'one-shot'}): ${r.description}\nParameters: ${paramText(r)}.\nDefault: base note ${g.baseNote}, ${g.pcm.length} samples at ${g.sampleRate} Hz, ~${g.brrBytes} BRR bytes.\nUse generate_sample {"recipe":"${r.id}","params":{...},"name":"..."} and then add_instrument with the new sample id.`)
      }
      const lines: string[] = []
      if (song.samples.length === 0) lines.push('Sample slots: none yet (presets add theirs; generate_sample adds one).')
      else lines.push(`Sample slots (${song.samples.length}):`, ...song.samples.map((s) => slotLine(song, s)))
      if (song.chip === 'snes') {
        const u = snesAramUsage(song)
        lines.push(`ARAM: ~${u.total} of ${u.budget} bytes used by samples that instruments play (${u.sampleBytes} sample + ${u.echoBytes} echo buffer); free ~${u.budget - u.total}.`)
      }
      lines.push('', `Recipes (${listRecipes().length}); list_samples {"recipe":"<id>"} shows the parameters:`)
      for (const r of listRecipes()) lines.push(`${r.id} (${r.role}, ${r.loops ? 'loop' : 'one-shot'}): ${r.description}`)
      return ok(lines.join('\n'))
    }
  }),

  defineTool({
    name: 'generate_sample',
    group: 'instruments',
    description:
      'Generate a sample from a recipe (strings, choir, organ, flute, brass, pad, bass, lead, harp, pluck, guitar, koto, bell, epiano, kick, snare, hat, openhat, crash, tom, clap) and add it to the song as a sample slot. Parameters depend on the recipe (list_samples {"recipe":"strings"}); seeds make noisy sounds reproducible. Returns the sample id, size and the add_instrument call that plays it: SNES uses kind "snes-sample" (with env and echo), the Genesis F6 DAC and the NES DPCM channel use kind "sample". One undo step. Example: {"recipe":"strings","params":{"bright":0.8},"name":"bright strings"}.',
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
      const bytes = g.brrBytes ?? brrByteSize(g.pcm.length)
      let extra = ''
      if (song.chip === 'snes') {
        const u = snesAramUsage(song)
        extra = `\nARAM: ~${u.total} of ${u.budget} bytes in use by instruments (this sample adds ~${bytes} once an instrument plays it).`
      }
      const how =
        song.chip === 'snes'
          ? `add_instrument {"params":{"kind":"snes-sample","name":"${instrumentSlug(name) || r.id}","sample":"${id}","baseNote":${g.baseNote},"env":{"adsr":[15,7,7,0]},"echo":true}}`
          : `add_instrument {"params":{"kind":"sample","name":"${instrumentSlug(name) || r.id}","sample":"${id}","baseNote":${g.baseNote}}}`
      return ok(
        `Added sample "${id}" (${r.id}${r.loops ? ', looping' : ', one-shot'}): ${plural(g.pcm.length, 'sample')} at ${g.sampleRate} Hz, ~${bytes} BRR bytes, base note ${g.baseNote}${g.loopStart !== undefined ? `, loop from ${g.loopStart}` : ''}.${extra}\nPlay it with ${how}.`
      )
    }
  })
]
