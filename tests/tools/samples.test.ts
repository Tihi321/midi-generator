// list_samples / generate_sample and how presets bring their samples along.

import { describe, expect, it } from 'vitest'
import { listRecipes } from '../../src/core'
import { resultText, songSetup } from './helpers'

describe('list_samples', () => {
  it('lists the recipes on an empty song and the details of one recipe', async () => {
    const t = songSetup({ chip: 'snes' })
    const all = await t.text('list_samples')
    expect(all).toMatch(/Sample slots: none yet/)
    expect(all).toMatch(/Recipes \(40\)/)
    for (const r of ['strings', 'choir', 'harp', 'bell', 'kick', 'snare', 'hat', 'crash', 'clap']) expect(all).toContain(`${r} (`)
    expect(all).toContain('ARAM: ~8192 of 65536 bytes used by samples that instruments play (0 sample + 8192 echo buffer)')
    const one = await t.text('list_samples', { recipe: 'kick' })
    expect(one).toMatch(/Recipe kick .*one-shot/)
    expect(one).toMatch(/startHz 80\.\.300 \(default 150\)/)
    const bad = await t.call('list_samples', { recipe: 'kazoo' })
    expect(bad.isError).toBe(true)
    expect(resultText(bad)).toMatch(/Unknown sample recipe "kazoo"\. Recipes: strings/)
  })
})

describe('generate_sample', () => {
  it('adds a recipe slot as one undo step and reports its size and the add_instrument call', async () => {
    const t = songSetup({ chip: 'snes' })
    const r = await t.text('generate_sample', { recipe: 'strings', params: { bright: 0.8 }, name: 'Bright Strings' })
    expect(r).toMatch(/Added sample "bright-strings" \(strings, looping\): \d+ samples at \d+ Hz, ~\d+ BRR bytes, base note 60, loop from \d+/)
    expect(r).toMatch(/"kind":"snes-sample".*"sample":"bright-strings"/)
    expect(t.song.samples).toHaveLength(1)
    expect(t.song.samples[0]!.source).toEqual({ kind: 'recipe', recipe: 'strings', params: expect.objectContaining({ bright: 0.8, note: 60 }) })
    // second one gets a unique id
    await t.ok('generate_sample', { recipe: 'strings', name: 'Bright Strings' })
    expect(t.song.samples.map((s) => s.id)).toEqual(['bright-strings', 'bright-strings-2'])
    await t.ok('undo')
    expect(t.song.samples).toHaveLength(1)
    await t.ok('undo')
    expect(t.song.samples).toHaveLength(0)
    await t.ok('redo')
    expect(t.song.samples).toHaveLength(1)
  })

  it('validates the recipe and its parameters with the valid values', async () => {
    const t = songSetup({ chip: 'snes' })
    expect(resultText(await t.call('generate_sample', { recipe: 'nope' }))).toMatch(/Unknown sample recipe "nope"\. Recipes: strings/)
    expect(resultText(await t.call('generate_sample', { recipe: 'kick', params: { seconds: 50 } }))).toMatch(/must be 0\.03\.\.1/)
    expect(resultText(await t.call('generate_sample', { recipe: 'kick', params: { colour: 1 } }))).toMatch(/no parameter "colour"\. Parameters: seconds/)
    expect(resultText(await t.call('generate_sample', { recipe: 'choir', params: { vowel: 'x' } }))).toMatch(/one of aah, ooh, eeh/)
    expect(t.song.samples).toHaveLength(0)
  })

  it('the generated sample can be played by an instrument made with add_instrument params', async () => {
    const t = songSetup({ chip: 'snes' })
    await t.ok('generate_sample', { recipe: 'bell', name: 'my bell' })
    const added = await t.text('add_instrument', { params: { kind: 'snes-sample', name: 'ding', sample: 'my-bell', baseNote: 72, env: { adsr: [15, 7, 7, 0] }, echo: true } })
    expect(added).toMatch(/Added instrument @0 "ding" \(snes-sample/)
    expect(await t.text('list_samples')).toMatch(/my-bell "my bell": recipe bell.*used by @0 ding/)
    await t.ok('write_pattern', { text: 'channels: V1\n 0 | C-5 @ding' })
    expect(await t.text('analyze_song')).toMatch(/Chip rules: no violations/)
  })
})

describe('presets add their samples', () => {
  it('add_instrument with a SNES preset adds the sample slot in the same undo step and re-uses it', async () => {
    const t = songSetup({ chip: 'snes' })
    const r = await t.text('add_instrument', { preset: 'snes.strings.ensemble' })
    expect(r).toMatch(/Added sample "strings" to the song/)
    expect(t.song.samples.map((s) => s.id)).toEqual(['strings'])
    expect(t.song.instruments[0]).toMatchObject({ kind: 'snes-sample', sample: 'strings', presetId: 'snes.strings.ensemble' })
    // brass section + stab share one slot
    await t.ok('add_instrument', { preset: 'snes.brass.section' })
    const stab = await t.text('add_instrument', { preset: 'snes.brass.stab' })
    expect(stab).not.toMatch(/Added sample/)
    expect(t.song.samples.map((s) => s.id)).toEqual(['strings', 'brass'])
    await t.ok('undo')
    expect(t.song.instruments).toHaveLength(2)
    await t.ok('undo')
    expect(t.song.instruments).toHaveLength(1)
    expect(t.song.samples.map((s) => s.id)).toEqual(['strings'])
    await t.ok('undo')
    expect(t.song.samples).toHaveLength(0)
    expect(t.song.instruments).toHaveLength(0)
  })

  it('role presets and write_drums add instruments and samples; Genesis DAC and NES DPCM presets resolve by channel kind', async () => {
    const t = songSetup({ chip: 'snes' })
    const drums = await t.text('write_drums', { channel: 'V7', legend: { K: 'kick', h: 'hat' }, steps: 'K.h.K.h.', repeat: 2 })
    expect(drums).toMatch(/Added instruments for the roles: @0 kick .*preset snes\.kick\.drum\) \+ sample "kick"; @1 hat/)
    expect(t.song.samples.map((s) => s.id).sort()).toEqual(['hat', 'kick'])

    const g = songSetup({ chip: 'genesis' })
    await g.ok('new_song', { chip: 'genesis', chipConfig: { fm6Dac: true } })
    expect(resultText(await g.ok('add_instrument', { preset: 'kick', channel: 'F6' }))).toMatch(/genesis\.dac\.kick.*Added sample "dac-kick"/)
    expect(g.session.song.samples[0]).toMatchObject({ id: 'dac-kick', source: { kind: 'recipe', recipe: 'kick' } })

    const n = songSetup({ chip: 'nes' })
    await n.ok('new_song', { chip: 'nes', chipConfig: { dpcm: true } })
    expect(resultText(await n.ok('add_instrument', { preset: 'snare', channel: 'DM' }))).toMatch(/nes\.dpcm\.snare.*Added sample "dpcm-snare"/)
    expect(n.session.song.instruments[0]).toMatchObject({ kind: 'sample', sample: 'dpcm-snare' })
  })
})
describe('list_samples and generate_sample on PS1 and Dreamcast', () => {
  /** The add_instrument arguments of the "Play it with ..." hint. */
  const hint = (text: string): Record<string, unknown> => JSON.parse(/Play it with add_instrument (\{.*\})\./.exec(text)![1]!)

  it('lists the new recipes and generate_sample names them', async () => {
    const t = songSetup({ chip: 'ps1' })
    const all = await t.text('list_samples')
    const ids = listRecipes().map((r) => r.id)
    expect(ids).toHaveLength(40)
    for (const id of ['supersaw', 'sawlead', 'syncsaw', 'junopad', 'analogbass', 'fmbass', 'synthpluck', 'synthbrass', 'dxepiano', 'dxbell', 'linnkick', '808kick', 'linnsnare', 'gatedsnare', 'linnclap', 'linnhat', 'linnopenhat', 'linntom', 'linncrash']) {
      expect(all, id).toContain(`${id} (`)
    }
    const defs = new Map(t.registry.defs().map((d) => [d.name, d.description]))
    for (const id of ids) expect(defs.get('generate_sample'), `generate_sample ${id}`).toContain(id)
    for (const id of ids.slice(21)) expect(defs.get('list_samples'), `list_samples ${id}`).toContain(id)
  })

  it('PS1: the RAM line, the ADPCM sizes and an add_instrument hint that works', async () => {
    const t = songSetup({ chip: 'ps1' })
    const empty = await t.text('list_samples')
    expect(empty).toContain('SPU RAM: ~32736 of 524288 bytes used by samples that instruments play (0 ADPCM + 28640 reverb work area of "studio-large" + 4096 reserved); free ~491552.')
    expect(empty).not.toContain('ARAM')
    const g = await t.text('generate_sample', { recipe: 'supersaw', name: 'wide saw' })
    expect(g).toMatch(/Added sample "wide-saw" \(supersaw, looping\): \d+ samples at \d+ Hz, ~\d+ PS-X ADPCM bytes, base note 60, loop from \d+\./)
    expect(g).toMatch(/SPU RAM: ~32736 of 524288 bytes in use by instruments \(this sample adds ~\d+ once an instrument plays it\)\./)
    const args = hint(g)
    expect(args['params']).toMatchObject({ kind: 'psx-sample', sample: 'wide-saw', baseNote: 60, reverb: true, adsr: { attack: expect.any(Number), release: expect.any(Number) } })
    expect(await t.text('add_instrument', args)).toMatch(/Added instrument @0 "wide-saw" \(psx-sample/)
    const listed = await t.text('list_samples')
    expect(listed).toMatch(/wide-saw "wide saw": recipe supersaw .*; \d+ samples, ~\d+ PS-X ADPCM bytes; used by @0 wide-saw/)
    const ram = /SPU RAM: ~(\d+) of 524288 bytes used by samples that instruments play \((\d+) ADPCM \+ 28640/.exec(listed)!
    expect(Number(ram[2])).toBeGreaterThan(5000)
    expect(Number(ram[1])).toBe(Number(ram[2]) + 28640 + 4096)
    // the reverb preset of the song is what the line reports
    await t.ok('set_song_info', { chipConfig: { reverb: { preset: 'off' } } })
    expect(await t.text('list_samples')).toContain('0 reverb work area of "off"')
    expect(await t.text('list_samples', { recipe: 'gatedsnare' })).toMatch(/Default: base note 60, \d+ samples at \d+ Hz, ~\d+ PS-X ADPCM bytes\./)
    await t.ok('write_pattern', { text: 'channels: V2\n 0 | C-5 @wide-saw v12' })
    expect(await t.text('analyze_song')).toMatch(/Chip rules: no violations/)
  })

  it('Dreamcast: the AICA RAM line, sizes per format and an add_instrument hint that works', async () => {
    const t = songSetup({ chip: 'dreamcast' })
    const empty = await t.text('list_samples')
    expect(empty).toContain('AICA RAM: ~131072 of 2097152 bytes used by samples that instruments play (0 samples + 131072 DSP buffer of "chorus-hall"); free ~1966080.')
    const g = await t.text('generate_sample', { recipe: 'linnsnare', name: 'snare 2' })
    expect(g).toMatch(/Added sample "snare-2" \(linnsnare, one-shot\): \d+ samples at \d+ Hz, ~\d+ pcm16 bytes, base note 60\./)
    expect(g).toMatch(/AICA RAM: ~131072 of 2097152 bytes in use by instruments \(this sample adds ~\d+ as pcm16, a quarter as adpcm, once an instrument plays it\)\./)
    const args = hint(g)
    expect(args['params']).toMatchObject({ kind: 'aica-sample', sample: 'snare-2', format: 'pcm16', aeg: { ar: 22, rr: 12 }, send: 8 })
    expect(await t.text('add_instrument', args)).toMatch(/Added instrument @0 "snare-2" \(aica-sample/)
    const listed = await t.text('list_samples')
    expect(listed).toMatch(/snare-2 "snare 2": recipe linnsnare .*; \d+ samples, ~\d+ bytes as pcm16 \(~\d+ as adpcm\); used by @0 snare-2/)
    const ram = /AICA RAM: ~(\d+) of 2097152 bytes used by samples that instruments play \((\d+) samples \+ 131072/.exec(listed)!
    expect(Number(ram[2])).toBeGreaterThan(1000)
    expect(Number(ram[1])).toBe(Number(ram[2]) + 131072)
    await t.ok('update_instrument', { instrument: 'snare-2', params: { format: 'adpcm' } })
    const adpcm = /AICA RAM: ~\d+ of 2097152 bytes used by samples that instruments play \((\d+) samples/.exec(await t.text('list_samples'))!
    expect(Number(adpcm[1])).toBeLessThan(Number(ram[2]) / 3)
    expect(await t.text('list_samples', { recipe: 'supersaw' })).toMatch(/Default: base note 60, \d+ samples at \d+ Hz, ~\d+ bytes as pcm16\./)
  })

  it('SNES and the other chips keep their text', async () => {
    const t = songSetup({ chip: 'snes' })
    const g = await t.text('generate_sample', { recipe: 'bell', name: 'chime' })
    expect(g).toMatch(/~\d+ BRR bytes, base note/)
    expect(g).toMatch(/ARAM: ~8192 of 65536 bytes in use by instruments/)
    expect(g).toContain('"kind":"snes-sample"')
    const n = songSetup({ chip: 'nes' })
    expect(await n.text('list_samples')).not.toMatch(/RAM/)
    expect(await n.text('generate_sample', { recipe: 'kick' })).toContain('"kind":"sample"')
  })
})
