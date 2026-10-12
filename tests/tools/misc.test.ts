import { describe, expect, it } from 'vitest'
import { decodePng, hasPngSignature, readWav, base64ToBytes } from '../../src/core'
import { resultText, snapshot, songSetup } from './helpers'

async function songWithMusic(chip: 'nes' | 'gb' = 'nes') {
  const t = songSetup({ chip })
  if (chip === 'nes') {
    await t.ok('add_instrument', { preset: 'lead', channel: 'P1' })
    await t.ok('add_instrument', { preset: 'bass', channel: 'TR' })
    await t.ok('write_melody', { channel: 'P1', melody: '@lead v12 E5:2 G5:2 A5:4 r:2 G5 F#5 E5:4 ~:4 {A4 C5 E5}:8 D5:4!4A2' })
    await t.ok('write_pattern', { text: 'channels: TR\n0 | A-2 @bass\n4 | A-2\n8 | E-2' })
  } else {
    await t.ok('add_instrument', { preset: 'lead', channel: 'P1' })
    await t.ok('add_instrument', { preset: 'bass', channel: 'WV' })
    await t.ok('write_melody', { channel: 'P1', melody: '@lead v12 E5:2 G5:2 A5:4' })
    await t.ok('write_pattern', { text: 'channels: WV\n0 | A-2 @bass v15\n8 | E-2 v8' })
  }
  await t.ok('write_drums', { legend: { K: 'kick', S: 'snare', h: 'hat' }, steps: 'K.h.S.h.K.KhS.h.', repeat: 4 })
  return t
}

describe('read_pattern', () => {
  it('reads tracker text that write_pattern accepts back unchanged', async () => {
    const t = await songWithMusic()
    const before = snapshot(t.song)
    const text = await t.text('read_pattern', { channels: ['P1', 'TR'], sparse: true })
    expect(text).toContain('channels: P1 | TR')
    expect(text).toContain('E-5 @lead v12')
    const body = text.slice(text.indexOf('\n') + 1)
    await t.ok('write_pattern', { text: body, mode: 'replace' })
    expect(snapshot(t.song)).toBe(before)
  })

  it('reads a melody that write_melody writes back, and drum steps that write_drums writes back', async () => {
    const t = await songWithMusic()
    const mel = await t.text('read_pattern', { format: 'melody', channel: 'P1' })
    const melody = mel.slice(mel.indexOf('\n') + 1)
    expect(melody).toMatch(/^@lead v12 E5:2 G5:2 A5:4 r:2/)
    const before = snapshot(t.song)
    await t.ok('write_melody', { channel: 'P1', melody, clear: true })
    expect(snapshot(t.song)).toBe(before)

    const dr = await t.text('read_pattern', { format: 'drums', channel: 'NO' })
    const spec = JSON.parse(dr.slice(dr.indexOf('\n') + 1)) as { legend: Record<string, string>; steps: string }
    expect(spec.steps).toHaveLength(64)
    await t.ok('write_drums', { ...spec, channel: 'NO', clear: true })
    expect(snapshot(t.song)).toBe(before)
  })

  it('reads a range and validates the channel', async () => {
    const t = await songWithMusic()
    const text = await t.text('read_pattern', { fromRow: 0, toRow: 4, channels: ['P1'] })
    expect(text.split('\n').filter((l) => /^\s*\d+ \|/.test(l))).toHaveLength(4)
    expect(resultText(await t.call('read_pattern', { channels: ['ZZ'] }))).toMatch(/Channel "ZZ" not found/)
    expect(resultText(await t.call('read_pattern', { order: 3 }))).toMatch(/Order 3 not found/)
  })
})

describe('render_preview', () => {
  it('returns a PNG piano roll plus a text summary and never changes the song', async () => {
    const t = await songWithMusic()
    const depth = t.session.history.undoDepth
    const r = await t.ok('render_preview')
    expect(t.session.history.undoDepth).toBe(depth)
    const img = r.content.find((c) => c.type === 'image') as { mimeType: string; data: string }
    expect(img.mimeType).toBe('image/png')
    const bytes = base64ToBytes(img.data)
    expect(hasPngSignature(bytes)).toBe(true)
    const png = decodePng(bytes)
    expect(png.width).toBeGreaterThan(300)
    expect(png.height).toBeGreaterThan(100)
    const text = resultText(r)
    expect(text).toMatch(/Piano roll of order rows 0\.\.0 \(64 rows, 4 bars\)/)
    expect(text).toMatch(/P1=red \(8 notes\)/)
    expect(text).toMatch(/NO=green \(36 drum hits\)/)
    // the roll draws something in the P1 colour
    const red = png.data.some((px) => (px & 255) > 200 && ((px >>> 8) & 255) < 100 && ((px >>> 16) & 255) < 100)
    expect(red).toBe(true)
  })

  it('shows chosen orders/channels, truncates huge songs and handles empty ones', async () => {
    const t = await songWithMusic()
    await t.ok('set_orders', { orders: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
    const all = resultText(await t.ok('render_preview'))
    expect(all).toMatch(/cut at order \d+/)
    const one = resultText(await t.ok('render_preview', { fromOrder: 3, toOrder: 3, channels: ['P1'], chipRange: true }))
    expect(one).toMatch(/order rows 3\.\.3 \(64 rows/)
    expect(one).toContain('P1=red')
    expect(one).not.toContain('TR=')
    expect(resultText(await t.call('render_preview', { fromOrder: 40 }))).toMatch(/fromOrder 40 is outside the song/)
    const empty = songSetup()
    expect(resultText(await empty.ok('render_preview'))).toMatch(/The song is empty in this range/)
  })
})

describe('analyze_song', () => {
  it('reports key, chords, channels, clashes and chip issues', async () => {
    const t = await songWithMusic()
    const text = await t.text('analyze_song')
    expect(text).toMatch(/Analysis of "test": 64 rows, 4 bars/)
    expect(text).toMatch(/Declared key: C major\. Detected: /)
    expect(text).toMatch(/P1: 8 notes/)
    expect(text).toMatch(/NO \(drums\): 36 notes/)
    expect(text).toMatch(/Chip rules: no violations for NES/)
    // relaxed songs can hold violations; the report lists them all
    await t.ok('set_song_info', { authenticity: 'relaxed' })
    await t.ok('set_cells', { cells: [{ channel: 'TR', row: 20, note: 40, vol: 4 }] })
    const again = await t.text('analyze_song')
    expect(again).toMatch(/Chip issues \(\d+\)/)
    expect(again).toMatch(/no volume on NES/)
    expect(await t.text('analyze_song', { skipChip: true })).not.toMatch(/Chip/)
  })
})

describe('instrument tools', () => {
  it('list_presets filters by role and channel and handles chips without presets', async () => {
    const t = songSetup()
    const lead = await t.text('list_presets', { role: 'lead' })
    expect(lead).toMatch(/nes\.lead\.duty25 \| name "lead" \| lead \| on pulse/)
    expect(lead).not.toContain('nes.bass')
    const tri = await t.text('list_presets', { channel: 'TR' })
    expect(tri).toContain('nes.bass.tri')
    expect(tri).not.toContain('nes.lead.duty25')
    expect(await t.text('list_presets', { chip: 'gb', role: 'bass' })).toContain('gb.bass.wave-saw')
    expect(await t.text('list_presets', { chip: 'snes', role: 'strings' })).toContain('snes.strings.ensemble')
    expect(resultText(await t.call('list_presets', { role: 'banjo' }))).toMatch(/Unknown role "banjo"/)
    expect(resultText(await t.call('list_presets', { channel: 'ZZ' }))).toMatch(/Channel "ZZ" not found on nes/)
  })

  it('add_instrument by preset id, role (+channel), params and preset+overrides', async () => {
    const t = songSetup()
    expect(await t.text('add_instrument', { preset: 'nes.lead.duty12' })).toMatch(/Added instrument @0 "lead-thin" \(nes-pulse, role lead, preset nes\.lead\.duty12\)\. Use it in tracker text as @lead-thin or @0\. Plays on: P1, P2/)
    expect(await t.text('add_instrument', { preset: 'bass' })).toMatch(/@1 "bass" \(nes-tri/)
    expect(await t.text('add_instrument', { preset: 'bass', channel: 'P2' })).toMatch(/@2 "bass-pulse" \(nes-pulse/)
    expect(await t.text('add_instrument', { preset: 'lead' })).toMatch(/@3 "lead"/)
    expect(await t.text('add_instrument', { preset: 'lead' })).toMatch(/@4 "lead-2"/) // names made unique
    const custom = await t.text('add_instrument', { params: { kind: 'nes-pulse', name: 'zap', macros: { vol: '15 12 9 6 3 0', timbre: '1', pitch: '-24 -20 -16' } } })
    expect(custom).toMatch(/@5 "zap" \(nes-pulse\)/)
    expect(t.song.instruments[5]).toMatchObject({ macros: { vol: { values: [15, 12, 9, 6, 3, 0] }, timbre: { values: [1] } } })
    await t.ok('add_instrument', { preset: 'lead', name: 'blip', params: { macros: { timbre: '2' } } })
    expect(t.song.instruments[6]).toMatchObject({ name: 'blip', macros: { timbre: { values: [2] } } })
    expect((t.song.instruments[6] as { macros: { vol?: unknown } }).macros.vol).toBeTruthy() // preset macros kept
    expect(t.session.history.undoDepth).toBe(7)
  })

  it('add_instrument validates and explains', async () => {
    const t = songSetup()
    expect(resultText(await t.call('add_instrument', {}))).toMatch(/Pass "preset"/)
    expect(resultText(await t.call('add_instrument', { preset: 'banjo' }))).toMatch(/Unknown preset or role "banjo" for nes\. Roles: lead/)
    expect(resultText(await t.call('add_instrument', { params: { name: 'x' } }))).toMatch(/needs a "kind"/)
    expect(resultText(await t.call('add_instrument', { params: { kind: 'gb-wave', name: 'w', wave: '00', level: 1 } }))).toMatch(/cannot be used on nes|32 hex digits/)
    expect(resultText(await t.call('add_instrument', { params: { kind: 'nes-pulse', name: 'x', macros: { vol: '99' } } }))).toMatch(/vol macro value #0 = 99 is out of range 0\.\.15/)
    expect(resultText(await t.call('add_instrument', { params: { kind: 'nes-pulse', name: 'x', macros: { bogus: '1' } } }))).toMatch(/Unknown macro "bogus"/)
    await t.ok('add_instrument', { preset: 'lead' })
    expect(resultText(await t.call('add_instrument', { preset: 'bass', name: 'Lead' }))).toMatch(/already used by @0/)
    expect(resultText(await t.call('add_instrument', { preset: 'lead', name: '12' }))).toMatch(/all digits/)
    expect(t.song.instruments).toHaveLength(1)
  })

  it('gb: wave instruments accept a hex string', async () => {
    const t = songSetup({ chip: 'gb' })
    await t.ok('add_instrument', { params: { kind: 'gb-wave', name: 'w1', wave: '0123456789ABCDEFFEDCBA9876543210', level: 1 } })
    expect(t.song.instruments[0]).toMatchObject({ kind: 'gb-wave', level: 1 })
    expect((t.song.instruments[0] as { wave: number[] }).wave).toHaveLength(32)
    expect(resultText(await t.call('add_instrument', { params: { kind: 'gb-wave', name: 'w2', wave: '012', level: 1 } }))).toMatch(/32 hex digits/)
    await t.ok('add_instrument', { params: { kind: 'gb-pulse', name: 'p', env: { init: 12, dir: 'down', pace: 2 }, duty: 2 } })
    expect(resultText(await t.call('add_instrument', { params: { kind: 'gb-pulse', name: 'p2', env: { init: 99, dir: 'down', pace: 2 } } }))).toMatch(/env\.init 99 must be an integer 0\.\.15/)
  })

  it('update_instrument merges, renames, protects the kind; get_instrument shows macros as text', async () => {
    const t = songSetup()
    await t.ok('add_instrument', { preset: 'lead' })
    await t.ok('write_pattern', { text: 'channels: P1\n0 | C-5 @lead' })
    const r = await t.text('update_instrument', { instrument: 'lead', params: { macros: { vol: '15 14 12 | 8', pitch: '0 0 3 -3' } }, name: 'lead-b' })
    expect(r).toMatch(/Updated instrument @0 "lead-b" \(nes-pulse\)\. 1 cell\(s\) use it/)
    const g = await t.text('get_instrument', { instrument: 0 })
    expect(g).toContain('used by 1 cell(s); plays on P1, P2')
    expect(g).toContain('"vol":"15 14 12 | 8"')
    expect(g).toContain('"timbre":"| 1"') // kept from the preset
    await t.ok('update_instrument', { instrument: '@lead-b', params: { macros: { pitch: null } } })
    expect(t.song.instruments[0]).not.toHaveProperty('macros.pitch')
    expect(resultText(await t.call('update_instrument', { instrument: 0, params: { kind: 'nes-tri' } }))).toMatch(/cannot change/)
    expect(resultText(await t.call('update_instrument', { instrument: 9, name: 'x' }))).toMatch(/Instrument 9 not found/)
    expect(await t.text('update_instrument', { instrument: 0 })).toMatch(/Nothing to change/)
    expect(await t.text('get_instrument')).toMatch(/@0 lead-b: nes-pulse, lead/)
  })

  it('delete_instrument refuses while used (listing where) and force clears the cells', async () => {
    const t = songSetup()
    await t.ok('add_instrument', { preset: 'lead' })
    await t.ok('add_instrument', { preset: 'arp' })
    await t.ok('write_pattern', { text: 'channels: P1 | P2\n0 | C-5 @lead | C-4 @arp\n4 | E-5 | E-4' })
    const r = await t.call('delete_instrument', { instrument: 'lead' })
    expect(r.isError).toBe(true)
    expect(resultText(r)).toMatch(/is used by 1 cell\(s\) \(e\.g\. P1 pattern 0 row 0\).*force: true/)
    expect(t.song.instruments).toHaveLength(2)
    const ok = await t.text('delete_instrument', { instrument: 'lead', force: true })
    expect(ok).toMatch(/Deleted instrument @0 "lead" \(1 cell lost their instrument\)\. 1 instrument\(s\) left/)
    expect(t.song.patterns.get('P1:0')!.rows[0]).toEqual({ note: 72 })
    expect(t.song.patterns.get('P2:0')!.rows[0]).toMatchObject({ inst: 0 }) // renumbered
    t.session.undo()
    expect(t.song.instruments).toHaveLength(2)
    expect(t.song.patterns.get('P1:0')!.rows[0]).toMatchObject({ inst: 0 })
  })
})

describe('theory tools', () => {
  it('get_mood_recipe lists moods, resolves aliases and shows the chip plan', async () => {
    const t = songSetup()
    const list = await t.text('get_mood_recipe')
    for (const m of ['heroic', 'battle', 'boss', 'spooky', 'dungeon', 'chill', 'town', 'overworld', 'victory', 'game-over', 'title', 'shop', 'underwater', 'desert', 'castle', 'sad']) expect(list).toContain(`${m}:`)
    const r = await t.text('get_mood_recipe', { mood: 'epic', chip: 'gb' })
    expect(r).toContain('Heroic (heroic)')
    expect(r).toContain('Channel plan for GB:')
    expect(r).toMatch(/Arrangement, 32 bars total/)
    expect(r).toMatch(/new_song \{"chip":"gb","mood":"heroic"\}/)
    expect(resultText(await t.call('get_mood_recipe', { mood: 'zzz' }))).toMatch(/Unknown mood "zzz"\. Valid moods: heroic/)
  })

  it('suggest_progression realises chords with arpeggio effects in the key', async () => {
    const t = songSetup()
    const r = await t.text('suggest_progression', { mood: 'heroic', key: 'D', limit: 2 })
    expect(r).toMatch(/2 progressions in D:/)
    expect(r).toMatch(/I=D \[D-3 F#3 A-3\] 047/)
    expect(await t.text('suggest_progression', { mode: 'minor', key: 'A', octave: 2 })).toMatch(/\[A-2 C-3 E-3\] 037/)
    expect(await t.text('suggest_progression', { mood: 'victory', mode: 'minor' })).toMatch(/No progressions match mood victory in minor/)
  })

  it('get_scale uses the song key by default', async () => {
    const t = songSetup()
    await t.ok('set_song_info', { key: 'D', scale: 'dorian' })
    const r = await t.text('get_scale')
    expect(r).toMatch(/^D Dorian/)
    expect(r).toContain('Pitch classes: D E F G A B C')
    expect(await t.text('get_scale', { key: 'E', scale: 'phrygian-dominant', octave: 3 })).toContain('E-3 F-3 G#3 A-3 B-3 C-4 D-4 E-4')
    expect(resultText(await t.call('get_scale', { scale: 'nope' }))).toMatch(/Unknown scale "nope"/)
  })

  it('get_drum_pattern lists styles and returns write_drums arguments that work', async () => {
    const t = songSetup()
    expect(await t.text('get_drum_pattern')).toMatch(/rock: Straight rock beat/)
    expect(await t.text('get_drum_pattern', { mood: 'boss' })).toMatch(/double-kick/)
    const r = await t.text('get_drum_pattern', { style: 'rock', bars: 2, fill: true })
    const json = r.split('\n').find((l) => l.startsWith('{'))!
    const args = JSON.parse(json) as { legend: Record<string, string>; steps: string; repeat: number }
    expect(args.steps).toHaveLength(32)
    expect(args.repeat).toBe(2)
    await t.ok('write_drums', args)
    expect(t.song.instruments.map((i) => i.role).sort()).toEqual(['hihat', 'kick', 'snare'])
    expect(resultText(await t.call('get_drum_pattern', { style: 'polka' }))).toMatch(/Unknown drum style "polka"\. Valid styles: rock/)
  })
})

describe('export_wav', () => {
  it('writes a looping WAV with smpl loop points and the stems next to it', async () => {
    const t = await songWithMusic()
    await t.ok('set_orders', { orders: [0, 0], loop: 1 })
    const depth = t.session.history.undoDepth
    const text = await t.text('export_wav', { path: 'theme', stems: true })
    expect(t.session.history.undoDepth).toBe(depth) // read-only: no undo step
    expect(text).toMatch(/Exported theme\.wav: \d+\.\d+ s, 44100 Hz stereo 16-bit, peak -?\d+\.\d dBFS/)
    expect(text).toMatch(/Loop points \(smpl chunk\): start \d+ .* end \d+/)
    const paths = [...t.services.files.keys()].sort()
    expect(paths).toEqual(['/mem/exports/theme.wav', '/mem/exports/theme_NO.wav', '/mem/exports/theme_P1.wav', '/mem/exports/theme_TR.wav'])
    const wav = readWav(t.services.files.get('/mem/exports/theme.wav')!)
    expect(wav.sampleRate).toBe(44100)
    expect(wav.numChannels).toBe(2)
    expect(wav.loops).toHaveLength(1)
    expect(wav.loops[0]!.start).toBeGreaterThan(0)
    expect(wav.loops[0]!.end).toBe(wav.length - 1)
    expect(wav.info['INAM']).toBe('test')
    const stem = readWav(t.services.files.get('/mem/exports/theme_P1.wav')!)
    expect(stem.length).toBe(wav.length)
    expect(stem.loops).toHaveLength(1)
  })

  it('supports loops, fade-out, sample rate, absolute paths; one-shot songs have no loop', async () => {
    const t = await songWithMusic()
    await t.ok('export_wav', {})
    expect(t.services.files.has('/mem/exports/test.wav')).toBe(true)
    const one = readWav(t.services.files.get('/mem/exports/test.wav')!)
    await t.ok('export_wav', { path: 'two.wav', loops: 2 })
    const two = readWav(t.services.files.get('/mem/exports/two.wav')!)
    expect(two.length).toBeGreaterThan(one.length * 1.4)
    const faded = await t.text('export_wav', { path: '/abs/faded', fadeOutSec: 1, sampleRate: 48000 })
    expect(faded).toMatch(/Faded out: no loop points/)
    const f = readWav(t.services.files.get('/abs/faded.wav')!)
    expect(f.sampleRate).toBe(48000)
    expect(f.loops).toHaveLength(0)
    const last = f.channels[0]!
    expect(Math.abs(last[last.length - 1]!)).toBeLessThan(0.01)
    await t.ok('set_loop', { order: null })
    expect(await t.text('export_wav', { path: 'shot' })).toMatch(/No loop points \(the song does not loop\)/)
    expect(readWav(t.services.files.get('/mem/exports/shot.wav')!).loops).toHaveLength(0)
    expect(t.services.audio.renders.length).toBe(4)
  })

  it('refuses empty songs, explaining why', async () => {
    const t = songSetup()
    expect(resultText(await t.call('export_wav'))).toMatch(/The song has no notes, so the WAV would be silent/)
    expect(t.services.files.size).toBe(0)
  })
})

describe('play, stop, undo, redo', () => {
  it('play and stop go through the audio service without an undo step', async () => {
    const t = await songWithMusic()
    await t.ok('set_orders', { orders: [0, 1] })
    const depth = t.session.history.undoDepth
    expect(await t.text('play', { order: 1, row: 8, loop: false })).toMatch(/Playing from order 1, row 8 \(no loop\)/)
    expect(t.services.audio.played).toEqual([{ from: { order: 1, row: 8 }, opts: { loop: false } }])
    expect(t.services.audio.playing).toBe(true)
    await t.ok('play')
    expect(t.services.audio.played[1]).toEqual({ from: undefined, opts: undefined })
    expect(await t.text('stop')).toMatch(/stopped/)
    expect(t.services.audio.playing).toBe(false)
    expect(t.session.history.undoDepth).toBe(depth)
    expect(resultText(await t.call('play', { order: 9 }))).toMatch(/Order 9 not found/)
    expect(resultText(await t.call('play', { row: 200 }))).toMatch(/Row 200 is outside the pattern/)
  })

  it('undo and redo step through the history and report labels', async () => {
    const t = songSetup()
    expect(await t.text('undo')).toBe('Nothing to undo.')
    await t.ok('add_instrument', { preset: 'lead' })
    await t.ok('set_song_info', { bpm: 99 })
    await t.ok('set_song_info', { bpm: 77 })
    expect(await t.text('undo')).toMatch(/Undid 1 step: set_song_info\./)
    expect(t.song.timing.bpm).toBe(99)
    expect(await t.text('undo', { steps: 5 })).toMatch(/Undid 2 steps: set_song_info, add_instrument\. \(no more undo steps\)/)
    expect(t.song.instruments).toHaveLength(0)
    expect(await t.text('redo', { steps: 2 })).toMatch(/Redid 2 steps/)
    expect(t.song.timing.bpm).toBe(99)
    expect(await t.text('redo', { steps: 9 })).toMatch(/Redid 1 step/)
    expect(await t.text('redo')).toBe('Nothing to redo.')
  })

  it('undo never goes below an open agent turn', async () => {
    const t = songSetup()
    await t.ok('set_song_info', { bpm: 99 })
    t.session.beginTurn('Agent: x')
    await t.ok('set_song_info', { bpm: 77 })
    expect(await t.text('undo', { steps: 5 })).toMatch(/Undid 1 step/)
    expect(t.song.timing.bpm).toBe(99)
    expect(await t.text('undo')).toBe('Nothing to undo.')
    t.session.endTurn()
  })
})
