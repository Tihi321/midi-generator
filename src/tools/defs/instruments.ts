import { z } from 'zod'
import {
  type ChipId,
  type Instrument,
  type Macro,
  type Macros,
  type SampleSlot,
  MACRO_NAMES,
  PRESET_BANKS,
  ROLES,
  ROLE_CHANNELS,
  createInstrumentCommand,
  formatMacro,
  instrumentSlug,
  instrumentUsage,
  listPresets,
  missingPresetSample,
  parseMacro,
  parseRole,
  requireChipId,
  requireInstrumentIndex,
  resolvePreset,
  songChannelDefs,
  chipChannels
} from '../../core'
import { addInstrumentWithSample } from '../editing'
import { defineTool } from '../registry'
import { CHANNEL_DESC, channelIdsText, channelRef, chipNotReadyNote, chipIsPlayable, instrumentRef, obj, ok, plural, songSession } from '../util'

const PARAMS_DESC =
  'Instrument data. add_instrument: a full instrument {"kind":..., "name":...} (or overrides on top of a preset). Kinds and fields: ' +
  'nes-pulse {macros:{vol,timbre(duty 0-3),arp,pitch}}, nes-tri {macros}, nes-noise {macros:{vol, arp(noise pitch 0-15, mode "fixed"), timbre(0 long,1 short)}}, ' +
  'gb-pulse {env:{init 0-15,dir "up"|"down",pace 0-7}, duty 0-3, sweep(P1 only){pace,dir,step}, macros}, gb-wave {wave: 32 values 0-15 or a 32-char hex string, level 0-3 (1=100%,2=50%,3=25%)}, gb-noise {env, short:boolean}, ' +
  'psg / psg-noise {macros, noiseMode "white"|"periodic"} (Genesis S1-S3 / NO), pce-wave {waves: [[32 values 0-31], ...] (timbre macro or Wxx picks the wave), noise?: boolean (C5/C6 only), macros}, ' +
  'fm {alg 0-7, fb 0-7, ams 0-3, pms 0-7, ops: 4 x {ar 0-31, dr 0-31, sr 0-31, rr 0-15, sl 0-15, tl 0-127, ks 0-3, ml 0-15, dt -3..3, ssg?, am?}}, ' +
  'snes-sample {sample: slot id (see list_samples / generate_sample), baseNote, env: {adsr:[a,d,sl,sr]} or {gain:{mode,rate}}, echo: boolean}, sample {sample, baseNote?} (NES DPCM, Genesis F6 DAC), ' +
  'psx-sample (PS1) {sample, baseNote, fine?, adsr: {attack 0-127, attackExp, decay 0-15, sustainLevel 0-15, sustainRate 0-127, sustainDir "dec"|"inc", sustainExp, release 0-31, releaseExp}, reverb: boolean, pmod?: boolean (pitch modulated by the voice before it, not on V1), noise?: {shift 0-15, step 0-3}}, ' +
  'aica-sample (Dreamcast) {sample, baseNote, fine?, format: "pcm16"|"pcm8"|"adpcm", aeg: {ar, d1r, d2r, rr 0-31, dl 0-31, krs? 0-15}, filter?: {q 0-31, flv: [5 values 0-8191], far, fd1r, fd2r, frr 0-31}, lfo?: {freq 0-31, pitchWave "saw"|"square"|"tri"|"noise", pitchDepth 0-7, ampWave, ampDepth 0-7, reset: boolean}, send: 0-15 (DSP send)}. Prefer presets for FM/SNES/PS1/Dreamcast. ' +
  'Macros are objects {values:[...],loop?,release?,mode?} or text like "15 12 9 | 6 3 / 0" (| = loop point, / = release point). vol macro 0-15 multiplies the cell volume, arp is in semitones, pitch in 1/16 semitone per tick. ' +
  'Example: {"kind":"nes-pulse","name":"zap","macros":{"vol":"15 12 9 6 3 0","timbre":"1","pitch":"-24 -20 -16 -12 -8 -4"}}.'

function normalizeMacro(name: string, v: unknown): Macro | null {
  if (v === null) return null
  if (typeof v === 'string') {
    const m = /^\s*fixed\b/i.test(v)
    return parseMacro(v.replace(/^\s*fixed\b/i, ''), m ? 'fixed' : undefined)
  }
  if (v && typeof v === 'object') return v as Macro
  throw new Error(`Macro "${name}" must be a text like "15 12 9 | 6 3" or an object {values:[...]}.`)
}

/** Accept text forms for macros and the gb-wave hex string. */
function normalizeParams(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(raw)
  if (out['macros'] !== undefined && out['macros'] !== null) {
    if (typeof out['macros'] !== 'object') throw new Error('"macros" must be an object like {"vol":"15 12 9","timbre":"1"}.')
    const res: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(out['macros'] as Record<string, unknown>)) {
      if (!(MACRO_NAMES as readonly string[]).includes(k)) throw new Error(`Unknown macro "${k}": use ${MACRO_NAMES.join(', ')}.`)
      res[k] = normalizeMacro(k, v)
    }
    out['macros'] = res
  }
  if (typeof out['wave'] === 'string') {
    const hex = out['wave'].trim()
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('wave as text must be exactly 32 hex digits (one per sample, 0-F), e.g. "0123456789ABCDEFFEDCBA9876543210".')
    out['wave'] = Array.from(hex).map((c) => parseInt(c, 16))
  }
  return out
}

function describeInstrument(inst: Instrument): Record<string, unknown> {
  const out = structuredClone(inst) as unknown as Record<string, unknown>
  const macros = (inst as { macros?: Macros }).macros
  if (macros) {
    const txt: Record<string, string> = {}
    for (const [k, m] of Object.entries(macros)) if (m) txt[k] = `${m.mode === 'fixed' ? 'fixed ' : ''}${formatMacro(m)}`
    out['macros'] = txt
  }
  return out
}

function channelsFor(song: Parameters<typeof songChannelDefs>[0], kind: string): string[] {
  return songChannelDefs(song).filter((d) => (d.instKinds as string[]).includes(kind)).map((d) => d.id)
}

export const instrumentTools = [
  defineTool({
    name: 'list_presets',
    group: 'instruments',
    readOnly: true,
    description:
      'List the instrument presets of a chip (default: the song\'s chip): id, default name, role, the channel kinds it plays on and a description, plus which channels play which role by default. Add one with add_instrument {preset:"<id>"} or by role ({preset:"lead"}). Filter by role (lead, bass, pad, kick, snare, hihat, ...) or by channel.',
    input: obj({
      chip: z.string().optional().describe('Chip (default: the song\'s).'),
      role: z.string().optional().describe(`Only this role: ${ROLES.join(', ')}.`),
      channel: channelRef.optional().describe(`Only presets that play on this channel. ${CHANNEL_DESC}`)
    }),
    handler: (args, ctx) => {
      const song = songSession(ctx).song
      const chip: ChipId = args.chip ? requireChipId(args.chip) : song.chip
      const role = args.role ? parseRole(args.role) : undefined
      if (args.role && !role) throw new Error(`Unknown role "${args.role}". Roles: ${ROLES.join(', ')}.`)
      let kind
      if (args.channel !== undefined) {
        const defs = chip === song.chip ? songChannelDefs(song) : chipChannels(chip)
        const d = defs.find((x, i) => x.id.toLowerCase() === String(args.channel).toLowerCase() || i === args.channel)
        if (!d) throw new Error(`Channel ${JSON.stringify(args.channel)} not found on ${chip}. Channels: ${defs.map((x) => x.id).join(', ')}.`)
        kind = d.kind
      }
      if (PRESET_BANKS[chip].length === 0) return ok(`No presets for ${chip.toUpperCase()} yet.\n${chipNotReadyNote(chip)}`)
      const list = listPresets(chip, { role, channelKind: kind })
      const lines = list.map((p) => `${p.id} | name "${p.name}" | ${p.role} | on ${p.channelKinds.join('/')} | ${p.description}`)
      const roles = Object.entries(ROLE_CHANNELS[chip]).map(([r, ch]) => `${r}: ${ch!.join(',')}`).join('; ')
      return ok(`${plural(list.length, 'preset')} for ${chip.toUpperCase()}${role ? ` (role ${role})` : ''}:\n${lines.join('\n')}\nDefault channels per role: ${roles}.\nAdd with add_instrument {"preset":"<id or role>"}.`)
    }
  }),

  defineTool({
    name: 'add_instrument',
    group: 'instruments',
    description:
      'Add an instrument to the song; returns its index (@n) and name, which tracker text refers to as @name or @n. Three ways: preset: a preset id ("nes.lead.duty25") or a ROLE ("lead", "bass", "pad", "arp", "kick", "snare", "hihat", ...) which picks the chip\'s default preset (pass channel so it picks the one that plays there, e.g. bass on TR vs P1); params: a full custom instrument; or both (preset + overrides). Names must be unique; a preset\'s default name is made unique automatically. The instrument is validated against the chip. Examples: {"preset":"lead"} | {"preset":"nes.bass.tri"} | {"preset":"hihat","channel":"NO"} | {"params":{"kind":"gb-wave","name":"bass2","wave":"0123456789ABCDEFFEDCBA9876543210","level":1}}. A song holds up to 64 instruments.',
    input: obj({
      preset: z.string().min(1).optional().describe('Preset id or role.'),
      channel: channelRef.optional().describe(`Channel the instrument is for (picks the right preset kind for a role). ${CHANNEL_DESC}`),
      name: z.string().min(1).optional().describe('Instrument name (letters/digits/-/_ become the @name reference).'),
      params: z.record(z.string(), z.unknown()).optional().describe(PARAMS_DESC)
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      let channelKind
      if (args.channel !== undefined) {
        const ci = songChannelDefs(song).findIndex((d, i) => d.id.toLowerCase() === String(args.channel).toLowerCase() || i === args.channel)
        if (ci < 0) throw new Error(`Channel ${JSON.stringify(args.channel)} not found. Channels: ${song.channels.map((c) => c.id).join(', ')}.`)
        channelKind = songChannelDefs(song)[ci]!.kind
      }
      if (!args.preset && !args.params) {
        throw new Error(`Pass "preset" (id or role: ${ROLES.join(', ')}; list_presets shows ids) or "params" (a full instrument with "kind"). Example: {"preset":"lead"}.`)
      }
      let inst: Record<string, unknown>
      let fromPreset = false
      let presetSlot: SampleSlot | undefined
      if (args.preset) {
        const resolved = resolvePreset(song.chip, args.preset, channelKind)
        presetSlot = missingPresetSample(song, resolved)
        inst = resolved as unknown as Record<string, unknown>
        fromPreset = true
        if (args.params) {
          const p = normalizeParams(args.params)
          const baseMacros = (inst['macros'] ?? {}) as Record<string, unknown>
          inst = { ...inst, ...p }
          if (p['macros']) inst['macros'] = { ...baseMacros, ...(p['macros'] as Record<string, unknown>) }
          delete inst['presetId']
        }
      } else {
        inst = normalizeParams(args.params!)
        if (!inst['kind']) throw new Error('params needs a "kind" (e.g. "nes-pulse", "gb-wave"); see the add_instrument description.')
      }
      let name = args.name ?? (typeof inst['name'] === 'string' ? inst['name'] : undefined)
      if (!name) name = String(inst['kind'])
      if (!args.name && fromPreset) {
        const taken = (n: string): boolean => song.instruments.some((x) => instrumentSlug(x.name) === instrumentSlug(n))
        const base = name
        for (let n = 2; taken(name); n++) name = `${base}-${n}`
      }
      inst['name'] = name
      const res = addInstrumentWithSample(session, inst as unknown as Instrument, presetSlot)
      const added = song.instruments[res.index]!
      const chans = channelsFor(song, added.kind)
      return ok(
        `Added instrument @${res.index} "${added.name}" (${added.kind}${added.role ? `, role ${added.role}` : ''}${added.presetId ? `, preset ${added.presetId}` : ''}). Use it in tracker text as @${instrumentSlug(added.name)} or @${res.index}. Plays on: ${channelIdsText(chans) || '(no channel of this chip)'}.${res.sampleAdded ? ` Added sample "${res.sampleAdded}" to the song (list_samples shows it).` : ''}`
      )
    }
  }),

  defineTool({
    name: 'update_instrument',
    group: 'instruments',
    description:
      'Change an instrument in place (every note that uses it changes). Pass the fields to change in params: they are merged over the instrument; macros merge per macro name (set a macro to null to remove it). The kind cannot change (delete and add instead). Optionally rename. Example: {"instrument":"lead","params":{"macros":{"vol":"15 14 12 10 | 8"}}} or {"instrument":2,"params":{"duty":1}}. See add_instrument for the fields of each kind.',
    input: obj({
      instrument: instrumentRef.describe('Instrument index or name.'),
      name: z.string().min(1).optional().describe('New name.'),
      params: z.record(z.string(), z.unknown()).optional().describe(PARAMS_DESC)
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const index = requireInstrumentIndex(song, args.instrument)
      const old = song.instruments[index]!
      if (!args.name && !args.params) return ok('Nothing to change: pass "name" and/or "params".')
      const p = args.params ? normalizeParams(args.params) : {}
      if (p['kind'] !== undefined && p['kind'] !== old.kind) throw new Error(`The kind of @${index} "${old.name}" is ${old.kind} and cannot change; delete_instrument and add_instrument a new one.`)
      delete p['kind']
      const patch: Record<string, unknown> = { ...p }
      if (p['macros'] !== undefined) {
        const merged: Record<string, unknown> = { ...((old as { macros?: Macros }).macros ?? {}) }
        for (const [k, v] of Object.entries(p['macros'] as Record<string, unknown>)) {
          if (v === null) delete merged[k]
          else merged[k] = v
        }
        patch['macros'] = merged
      }
      if (args.name) patch['name'] = args.name
      delete patch['presetId']
      session.execute(createInstrumentCommand(song, { op: 'update', ref: index, patch: patch as Partial<Instrument> }))
      const now = song.instruments[index]!
      return ok(`Updated instrument @${index} "${now.name}" (${now.kind}). ${instrumentUsage(song, index).count} cell(s) use it.`)
    }
  }),

  defineTool({
    name: 'delete_instrument',
    group: 'instruments',
    description:
      'Delete an instrument. If notes still use it the call fails and tells you where; with force:true the instrument is removed and those cells lose their instrument (the following instruments are renumbered automatically). Example: {"instrument":"arp","force":true}.',
    input: obj({
      instrument: instrumentRef.describe('Instrument index or name.'),
      force: z.boolean().optional().describe('Delete even if cells use it (they lose the instrument).')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const index = requireInstrumentIndex(song, args.instrument)
      const name = song.instruments[index]!.name
      const used = instrumentUsage(song, index).count
      session.execute(createInstrumentCommand(song, { op: 'delete', ref: index, force: args.force }))
      return ok(`Deleted instrument @${index} "${name}"${used ? ` (${plural(used, 'cell')} lost their instrument)` : ''}. ${song.instruments.length} instrument(s) left; later ones moved down by one.`)
    }
  }),

  defineTool({
    name: 'get_instrument',
    group: 'instruments',
    readOnly: true,
    description: 'Show one instrument\'s full data (kind, macros as text, envelope, wave, ...), how many cells use it and on which channels it can play. Omit "instrument" to list all instruments briefly.',
    input: obj({ instrument: instrumentRef.optional().describe('Instrument index or name (default: list all).') }),
    handler: (args, ctx) => {
      const song = songSession(ctx).song
      if (args.instrument === undefined) {
        if (song.instruments.length === 0) return ok(`No instruments yet. add_instrument {"preset":"lead"} adds one.${chipIsPlayable(song.chip) ? '' : '\n' + chipNotReadyNote(song.chip)}`)
        return ok(song.instruments.map((x, i) => `@${i} ${x.name}: ${x.kind}${x.role ? `, ${x.role}` : ''}${x.presetId ? `, ${x.presetId}` : ''}; used by ${instrumentUsage(song, i).count} cell(s)`).join('\n'))
      }
      const index = requireInstrumentIndex(song, args.instrument)
      const inst = song.instruments[index]!
      const u = instrumentUsage(song, index)
      return ok(`Instrument @${index} "${inst.name}": used by ${u.count} cell(s); plays on ${channelIdsText(channelsFor(song, inst.kind)) || 'no channel'}.\n${JSON.stringify(describeInstrument(inst))}`)
    }
  })
]
