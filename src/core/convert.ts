// convertChip: rebuild a song for another chip. Channels are mapped by role/kind (bass, lead, harmony, drums),
// instruments are replaced by the target chip's presets for the same role, notes are moved by octaves into the
// target channel's range, drum notes follow the target's conventions, effects the target channel cannot play are
// dropped, and timing, orders, loop point and metadata are kept. Every decision goes into the report.

import type { Cell, ChannelKind, ChipConfig, ChipId, Effect, EffectCode, Instrument, Role, Song } from './types'
import { CHIP_IDS } from './types'
import { chipChannels, defaultChipConfig, formatIssues, getChipProfile, songChannelDefs, validateSong, type ChannelDef } from './chips'
import { createSong, cloneSong } from './model'
import { findPreset, resolvePreset } from './instruments/presets'
import { defaultDrumNote } from './codecs/drumText'
import { effectiveRole } from './codecs/gmMap'
import { DRUM_PRIORITY, chipSlots, isLowDrum } from './codecs/slots'
import { addSongInstrument, bestOctaveShift, foldIntoRange, presetFor, snapVolume, writeChannelPatterns } from './codecs/songBuild'
import { formatNote } from './notes'

export interface ConvertOptions {
  name?: string
  authenticity?: 'strict' | 'relaxed'
  /** Settings of the target chip (NES `{dpcm:true}`, Genesis `{fm6Dac:true}`, ...). */
  chipConfig?: Partial<ChipConfig>
}

export interface ConvertResult {
  song: Song
  report: string[]
}

const DRUM_ROLES = new Set<Role>(['kick', 'snare', 'hihat', 'openhat', 'crash', 'tom', 'clap'])
const FLOW: EffectCode[] = ['B', 'C', 'D', 'F']
const NOISE_KINDS = new Set<ChannelKind>(['noise', 'psg-noise'])
const MAX_DROP_LINES = 10

/** "V13, V14, V15 ... V64": the first few ids and the last one, so a 64-voice list stays one short line. */
function listIds(ids: string[], max = 8): string {
  return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max - 1).join(', ')} ... ${ids[ids.length - 1]}`
}

interface SrcInfo {
  ci: number
  def: ChannelDef
  notes: number
  drumNotes: number
  melodicNotes: number
  pitchSum: number
  bassNotes: number
  isDrumChannel: boolean
}

interface Sticky {
  inst: number
  vol: number
}

function forEachCell(song: Song, ci: number, fn: (cell: Cell, index: number, state: Sticky) => void): void {
  const ch = song.channels[ci]!
  const L = song.patternLength
  const state: Sticky = { inst: -1, vol: 15 }
  for (let o = 0; o < song.orders.length; o++) {
    const n = song.orders[o]?.[ci]
    const pat = n === undefined ? undefined : song.patterns.get(`${ch.id}:${n}`)
    for (let r = 0; r < L; r++) {
      const cell = pat?.rows[r]
      if (!cell) continue
      fn(cell, o * L + r, state)
      if (cell.inst !== undefined) state.inst = cell.inst
      if (cell.vol !== undefined) state.vol = cell.vol
    }
  }
}

function roleOfInstrument(inst: Instrument | undefined, kind: ChannelKind): Role | undefined {
  return inst ? effectiveRole(inst, kind) : undefined
}

/** Note a drum hit plays on a target channel of this kind (noise/sample channels ignore pitch; pitched ones need a sensible one). */
function drumNoteFor(role: Role, kind: ChannelKind): number {
  if (kind === 'triangle') return defaultDrumNote(role, kind)
  if (kind === 'noise' || kind === 'psg-noise' || kind === 'dpcm' || kind === 'sample' || kind === 'pce-wave') return 60
  return role === 'kick' ? 36 : role === 'tom' ? 48 : 60
}

const noteName = (n: number): string => (n >= 12 && n <= 127 ? formatNote(n) : String(n))

/** Convert a song to another chip. See the file header for the rules. */
export function convertChip(song: Song, target: ChipId, opts: ConvertOptions = {}): ConvertResult {
  if (!CHIP_IDS.includes(target)) throw new Error(`Unknown chip "${String(target)}". Valid chips: ${CHIP_IDS.join(', ')}.`)
  const report: string[] = []
  const tcfg = { ...defaultChipConfig(target), ...(opts.chipConfig ?? {}), chip: target } as ChipConfig
  const sameConfig = target === song.chip && (!opts.chipConfig || JSON.stringify(tcfg) === JSON.stringify(song.chipConfig))
  if (sameConfig) {
    const copy = cloneSong(song)
    report.push(`The song is already a ${target.toUpperCase()} song with these settings: nothing to convert.`)
    return { song: copy, report }
  }

  const out = createSong({
    chip: target,
    name: opts.name ?? song.name,
    bpm: song.timing.bpm,
    speed: song.timing.speed,
    rowsPerBeat: song.timing.rowsPerBeat,
    beatsPerBar: song.timing.beatsPerBar,
    groove: song.timing.groove,
    key: song.meta.key,
    scale: song.meta.scale,
    moods: song.meta.moods,
    tags: song.meta.tags,
    patternLength: song.patternLength,
    authenticity: opts.authenticity ?? song.authenticity,
    chipConfig: tcfg
  })
  if (song.meta.notes) out.meta.notes = song.meta.notes
  out.references = song.references.map((r) => ({ ...r }))
  out.orders = song.orders.map(() => out.channels.map(() => 0))
  out.loop = song.loop ? { ...song.loop } : null
  const L = song.patternLength
  const rows = song.orders.length * L
  const srcDefs = songChannelDefs(song)
  const tdefs = chipChannels(target, tcfg)
  const tdef = (id: string): ChannelDef => tdefs.find((d) => d.id === id)!
  const tIndex = (id: string): number => out.channels.findIndex((c) => c.id === id)
  report.push(`Converting "${song.name}" from ${song.chip.toUpperCase()} (${song.channels.length} channels) to ${target.toUpperCase()} (${out.channels.length} channels).`)

  // ---- analyse the source channels
  const infos: SrcInfo[] = song.channels.map((ch, ci) => {
    const def = srcDefs.find((d) => d.id === ch.id)!
    const info: SrcInfo = { ci, def, notes: 0, drumNotes: 0, melodicNotes: 0, pitchSum: 0, bassNotes: 0, isDrumChannel: false }
    forEachCell(song, ci, (cell, _i, st) => {
      if (typeof cell.note !== 'number') return
      info.notes++
      const inst = song.instruments[cell.inst ?? st.inst]
      const role = roleOfInstrument(inst, def.kind)
      const drum = (role !== undefined && DRUM_ROLES.has(role)) || NOISE_KINDS.has(def.kind) || def.kind === 'dpcm'
      if (drum) info.drumNotes++
      else {
        info.melodicNotes++
        info.pitchSum += cell.note
        if (role === 'bass') info.bassNotes++
      }
    })
    info.isDrumChannel = info.notes > 0 && info.drumNotes >= info.notes * 0.6
    return info
  })
  const active = infos.filter((i) => i.notes > 0)
  const drumSources = active.filter((i) => i.isDrumChannel)
  const melodicSources = active.filter((i) => !i.isDrumChannel)
  const meanOf = (i: SrcInfo): number => i.pitchSum / Math.max(1, i.melodicNotes)

  const hasDrums = drumSources.length > 0
  const slots = chipSlots(target, tcfg, hasDrums)

  // ---- rank melodic sources
  const maxCount = Math.max(1, ...melodicSources.map((i) => i.melodicNotes))
  const means = melodicSources.map(meanOf)
  const minMean = Math.min(...means, 127)
  const maxMean = Math.max(...means, 0)
  const score = (i: SrcInfo): number => 0.6 * (i.melodicNotes / maxCount) + 0.4 * (maxMean === minMean ? 0.5 : (meanOf(i) - minMean) / (maxMean - minMean))
  const ranked = [...melodicSources].sort((a, b) => score(b) - score(a))
  let bassSrc: SrcInfo | undefined
  const bassLike = ranked.filter((i) => i.bassNotes >= i.melodicNotes * 0.5)
  if (bassLike.length > 0) bassSrc = [...bassLike].sort((a, b) => meanOf(a) - meanOf(b))[0]
  else if (melodicSources.length > 1) {
    const lowest = [...melodicSources].sort((a, b) => meanOf(a) - meanOf(b))[0]!
    if (meanOf(lowest) <= 52) bassSrc = lowest
  }

  // ---- assign melodic sources to target channels
  const assigned = new Map<number, string>() // source index -> target channel id
  const taken = new Set<string>()
  const drumIds = hasDrums ? new Set([slots.drumLow, slots.drumHigh]) : new Set<string>()
  for (const i of ranked) {
    const same = tdefs.find((d) => d.id === i.def.id && d.kind === i.def.kind && !taken.has(d.id) && !drumIds.has(d.id))
    if (same && (i !== bassSrc || same.id === slots.bass)) {
      assigned.set(i.ci, same.id)
      taken.add(same.id)
    }
  }
  if (bassSrc && !assigned.has(bassSrc.ci) && !taken.has(slots.bass)) {
    assigned.set(bassSrc.ci, slots.bass)
    taken.add(slots.bass)
  }
  const pool = [slots.lead, ...slots.harmony, ...(bassSrc ? [] : [slots.bass])].filter((id) => !taken.has(id))
  const dropped: SrcInfo[] = []
  for (const i of ranked) {
    if (assigned.has(i.ci)) continue
    const id = pool.shift()
    if (!id) dropped.push(i)
    else {
      assigned.set(i.ci, id)
      taken.add(id)
    }
  }

  // ---- linear cell lists per target channel
  const linear = new Map<number, (Cell | null)[]>()
  const ensure = (id: string): (Cell | null)[] => {
    const ci = tIndex(id)
    let arr = linear.get(ci)
    if (!arr) linear.set(ci, (arr = new Array<Cell | null>(rows).fill(null)))
    return arr
  }
  const instCache = new Map<string, number>()
  const dropFx = new Map<string, number>()
  let fxTruncated = 0
  let volDropped = 0

  const mapInstrument = (srcIdx: number, def: ChannelDef, srcKind: ChannelKind, fallbackRole: Role): number => {
    const key = `${def.kind}:${srcIdx}`
    const cached = instCache.get(key)
    if (cached !== undefined) return cached
    const src = song.instruments[srcIdx]
    let inst: Instrument | undefined
    if (src?.presetId) {
      const rest = src.presetId.split('.').slice(1).join('.')
      const p = findPreset(target, rest)
      if (p && p.channelKinds.includes(def.kind)) inst = resolvePreset(target, p.id)
    }
    const role = roleOfInstrument(src, srcKind) ?? fallbackRole
    if (!inst) inst = presetFor(target, role, def.kind)
    const idx = addSongInstrument(out, inst)
    instCache.set(key, idx)
    report.push(
      `  instrument @${srcIdx} "${src?.name ?? '?'}" (${src?.kind ?? '?'}${src?.role ? `, ${src.role}` : ''}) -> @${idx} "${out.instruments[idx]!.name}" (${out.instruments[idx]!.presetId ?? out.instruments[idx]!.kind}) on ${def.id}.`
    )
    return idx
  }

  const filterFx = (fx: Effect[] | undefined, srcKind: ChannelKind, def: ChannelDef): Effect[] | undefined => {
    if (!fx || fx.length === 0) return undefined
    const keep: Effect[] = []
    for (const e of fx) {
      let ok = def.effects.includes(e.code)
      if (ok && e.code === 'W') ok = (srcKind === def.kind && srcKind !== 'fm') || (NOISE_KINDS.has(srcKind) && NOISE_KINDS.has(def.kind))
      if (ok && e.code === 'X') ok = def.pan !== 'none'
      if (!ok) {
        dropFx.set(`${e.code}@${def.id}`, (dropFx.get(`${e.code}@${def.id}`) ?? 0) + 1)
        continue
      }
      keep.push({ code: e.code, param: e.param })
    }
    if (keep.length > def.fxColumns) {
      fxTruncated += keep.length - def.fxColumns
      keep.sort((a, b) => Number(FLOW.includes(b.code)) - Number(FLOW.includes(a.code)))
      keep.length = def.fxColumns
    }
    return keep.length > 0 ? keep : undefined
  }

  for (const info of ranked) {
    const tid = assigned.get(info.ci)
    if (!tid) continue
    const def = tdef(tid)
    const srcCh = song.channels[info.ci]!
    const isBass = info === bassSrc
    report.push(
      `${srcCh.id} (${info.def.kind}, ${info.notes} notes, mean ${info.melodicNotes ? noteName(Math.round(meanOf(info))) : '-'}) -> ${tid} ${def.name}${isBass ? ' [bass]' : tid === slots.lead ? ' [lead]' : ' [harmony]'}.`
    )
    // octave shift from the melodic notes
    const pitches: number[] = []
    forEachCell(song, info.ci, (cell, _i, st) => {
      if (typeof cell.note !== 'number') return
      const role = roleOfInstrument(song.instruments[cell.inst ?? st.inst], info.def.kind)
      if (role !== undefined && DRUM_ROLES.has(role)) return
      pitches.push(cell.note)
    })
    const shift = bestOctaveShift(pitches, def.noteMin, def.noteMax)
    if (shift !== 0) report.push(`  transposed ${shift > 0 ? '+' : ''}${shift} semitones into ${tid}'s range ${noteName(def.noteMin)}..${noteName(def.noteMax)}.`)
    let folded = 0
    const lin = ensure(tid)
    forEachCell(song, info.ci, (cell, idx, st) => {
      const c: Cell = {}
      const srcInstIdx = cell.inst ?? st.inst
      const srcInst = song.instruments[srcInstIdx]
      const role = roleOfInstrument(srcInst, info.def.kind)
      const drum = role !== undefined && DRUM_ROLES.has(role)
      if (typeof cell.note === 'number') {
        if (drum && !def.noise && def.kind !== 'sample') {
          c.note = foldIntoRange(cell.note, def.noteMin, def.noteMax).note
        } else if (drum) c.note = drumNoteFor(role!, def.kind)
        else {
          const moved = cell.note + shift
          const f = foldIntoRange(moved, def.noteMin, def.noteMax)
          if (f.moved) folded++
          c.note = f.note
        }
      } else if (cell.note !== undefined) c.note = cell.note
      if (cell.inst !== undefined) c.inst = mapInstrument(cell.inst, def, info.def.kind, isBass ? 'bass' : 'lead')
      else if (typeof cell.note === 'number' && st.inst >= 0) mapInstrument(st.inst, def, info.def.kind, isBass ? 'bass' : 'lead')
      if (cell.vol !== undefined) {
        if (def.hasVolume) c.vol = snapVolume(cell.vol, def)
        else volDropped++
      }
      const fx = filterFx(cell.fx, info.def.kind, def)
      if (fx) c.fx = fx
      lin[idx] = Object.keys(c).length > 0 ? c : null
    })
    if (folded > 0) report.push(`  ${folded} note(s) moved by octaves to fit the range.`)
    const srcState = song.channels[info.ci]!
    const tState = out.channels[tIndex(tid)]!
    if (srcState.muted) tState.muted = true
    if (srcState.trim !== undefined) tState.trim = srcState.trim
    if (srcState.pan !== undefined && def.pan !== 'none') tState.pan = srcState.pan
  }

  // ---- drums: gather hits from every drum channel, place them by role
  if (hasDrums) {
    const hits = new Map<number, Map<Role, number>>()
    const srcIds: string[] = []
    for (const info of drumSources) {
      srcIds.push(song.channels[info.ci]!.id)
      forEachCell(song, info.ci, (cell, idx, st) => {
        if (typeof cell.note !== 'number') return
        const inst = song.instruments[cell.inst ?? st.inst]
        const role = roleOfInstrument(inst, info.def.kind) ?? (info.def.kind === 'dpcm' ? 'kick' : 'snare')
        const r: Role = DRUM_ROLES.has(role) ? role : info.def.kind === 'dpcm' ? 'kick' : 'snare'
        const vol = cell.vol ?? st.vol
        let m = hits.get(idx)
        if (!m) hits.set(idx, (m = new Map()))
        m.set(r, Math.max(m.get(r) ?? 0, vol))
      })
    }
    const lowId = slots.drumLow
    const highId = slots.drumHigh
    const ids = [...new Set([lowId, highId])]
    const lost = new Map<string, number>()
    const roleTotals = new Map<Role, number>()
    let placed = 0
    for (const [idx, m] of [...hits].sort((a, b) => a[0] - b[0])) {
      const byId = new Map<string, [Role, number][]>()
      for (const [role, vol] of m) {
        const id = ids.length === 1 ? lowId : isLowDrum(role) ? lowId : highId
        const arr = byId.get(id) ?? []
        arr.push([role, vol])
        byId.set(id, arr)
      }
      for (const [id, cands] of byId) {
        cands.sort((a, b) => (DRUM_PRIORITY[a[0]] ?? 9) - (DRUM_PRIORITY[b[0]] ?? 9))
        const [role, vol] = cands[0]!
        const d = tdef(id)
        const key = `${d.kind}:drum:${role}`
        let instIdx = instCache.get(key)
        if (instIdx === undefined) {
          const inst = presetFor(target, role, d.kind)
          instIdx = addSongInstrument(out, inst)
          instCache.set(key, instIdx)
          report.push(`  drum ${role} -> @${instIdx} "${out.instruments[instIdx]!.name}" (${out.instruments[instIdx]!.presetId ?? out.instruments[instIdx]!.kind}) on ${id}.`)
        }
        const cell: Cell = { note: drumNoteFor(role, d.kind), inst: instIdx }
        if (d.hasVolume) cell.vol = snapVolume(vol, d)
        ensure(id)[idx] = cell
        placed++
        roleTotals.set(role, (roleTotals.get(role) ?? 0) + 1)
        for (const l of cands.slice(1)) lost.set(`${l[0]} on ${id}`, (lost.get(`${l[0]} on ${id}`) ?? 0) + 1)
      }
    }
    report.push(`Drums: ${placed} hit(s) from ${srcIds.length > 6 ? `${srcIds.length} channels (${listIds(srcIds, 5)})` : srcIds.join(' + ')} placed on ${ids.join(' + ')} by role (${[...roleTotals].map(([r, c]) => `${r} x${c}`).join(', ')}); drum notes use the ${target.toUpperCase()} convention.`)
    if (lost.size > 0) report.push(`Dropped ${[...lost.values()].reduce((a, b) => a + b, 0)} simultaneous drum hit(s) that did not fit one note per channel: ${[...lost].map(([k, c]) => `${k} x${c}`).join(', ')}.`)
    for (const id of ids) {
      for (const info of drumSources) {
        const sc = song.channels[info.ci]!
        if (sc.muted) out.channels[tIndex(id)]!.muted = true
      }
    }
  }

  // ---- dropped channels, flow effects of unmapped channels
  // a 24/64-voice song going to a 4-channel chip drops dozens of channels: one line each for the first 10, then a summary
  for (const d of dropped.slice(0, MAX_DROP_LINES)) {
    report.push(`Dropped ${song.channels[d.ci]!.id} (${d.notes} notes, mean ${noteName(Math.round(meanOf(d)))}): ${target.toUpperCase()} has no free melodic channel for it.`)
  }
  if (dropped.length > MAX_DROP_LINES) {
    const rest = dropped.slice(MAX_DROP_LINES)
    report.push(
      `Dropped ${rest.length} more channel(s) (${rest.reduce((n, d) => n + d.notes, 0)} notes in total, the least important ones): ${listIds(rest.map((d) => d.ci).sort((a, b) => a - b).map((ci) => song.channels[ci]!.id))}; ${target.toUpperCase()} has no free melodic channel for them.`
    )
  }
  const mappedSources = new Set<number>([...assigned.keys(), ...drumSources.map((i) => i.ci)])
  const hostId = [...assigned.values(), ...(hasDrums ? [slots.drumHigh] : [])][0] ?? out.channels[0]!.id
  let grafted = 0
  song.channels.forEach((_ch, ci) => {
    if (mappedSources.has(ci)) return
    forEachCell(song, ci, (cell, idx) => {
      const flow = cell.fx?.filter((e) => FLOW.includes(e.code))
      if (!flow || flow.length === 0) return
      const arr = ensure(hostId)
      const cur = arr[idx] ? { ...arr[idx]! } : {}
      const fx: Effect[] = [...(cur.fx ?? [])]
      const defHost = tdef(hostId)
      for (const e of flow) {
        if (fx.some((x) => x.code === e.code) || fx.length >= defHost.fxColumns) continue
        fx.push({ code: e.code, param: e.param })
        grafted++
      }
      cur.fx = fx
      arr[idx] = cur
    })
  })
  if (grafted > 0) report.push(`Moved ${grafted} flow effect(s) (Bxx/Cxx/Dxx/Fxx) from unmapped channels to ${hostId} so the song keeps its structure and tempo.`)

  if (volDropped > 0) report.push(`Dropped ${volDropped} volume value(s): the target channel has no volume control.`)
  if (dropFx.size > 0) {
    report.push(`Dropped effects the target channels do not support: ${[...dropFx].map(([k, c]) => `${k.replace('@', ' on ')} x${c}`).join(', ')}.`)
  }
  if (fxTruncated > 0) report.push(`Dropped ${fxTruncated} effect(s) beyond the target channel's effect columns.`)

  // ---- write patterns
  for (const [ci, cells] of [...linear].sort((a, b) => a[0] - b[0])) writeChannelPatterns(out, ci, cells)
  const keptTimings = song.timing.groove ? ', groove' : ''
  report.push(`Kept: tempo ${song.timing.bpm} BPM, ${song.orders.length} order row(s), pattern length ${L}, loop ${song.loop ? `at order ${song.loop.order}` : 'none'}, key ${song.meta.key} ${song.meta.scale}${keptTimings}.`)
  if (getChipProfile(target).id !== target) report.push('Warning: internal chip mismatch.')

  const issues = validateSong(out)
  if (issues.length === 0) report.push(`The converted song passes the ${target.toUpperCase()} chip rules.`)
  else report.push(`Remaining chip-rule findings:\n${formatIssues(issues, 8)}`)
  return { song: out, report }
}
