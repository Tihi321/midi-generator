import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractGuide, renderGuideModule } from '../../scripts/gen-guide.mjs'
import { CHIP_IDS, MOOD_IDS, PRESET_BANKS } from '../../src/core'
import { GUIDE, GUIDE_SHORT, createDefaultRegistry } from '../../src/tools'

const md = readFileSync(resolve(__dirname, '../../docs/llm-guide.md'), 'utf8')

describe('LLM guide', () => {
  it('guideText.ts is in sync with docs/llm-guide.md (run `yarn gen:guide`)', () => {
    const expected = renderGuideModule(md).replace(/\r\n/g, '\n')
    const actual = readFileSync(resolve(__dirname, '../../src/tools/guideText.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(actual).toBe(expected)
    const { guide, short } = extractGuide(md)
    expect(GUIDE).toBe(guide)
    expect(GUIDE_SHORT).toBe(short)
  })

  it('the short guide is at most 1500 characters and is part of the full guide', () => {
    expect(GUIDE_SHORT.length).toBeLessThanOrEqual(1500)
    expect(GUIDE).toContain(GUIDE_SHORT)
  })

  it('every tool-like name in backticks is a registered tool, and the core workflow tools are all mentioned', () => {
    const tools = new Set(createDefaultRegistry().list().map((t) => t.name))
    const names = new Set([...GUIDE.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!))
    const unknown = [...names].filter((n) => !tools.has(n))
    expect(unknown).toEqual([])
    const core = ['get_song', 'get_mood_recipe', 'new_song', 'add_instrument', 'write_drums', 'write_pattern', 'write_melody', 'set_orders', 'set_loop', 'analyze_song', 'render_preview', 'export_wav', 'undo']
    for (const n of core) expect(GUIDE, n).toContain('`' + n + '`')
    for (const n of core) expect(tools.has(n), n).toBe(true)
  })

  it('the short guide names the workflow tools', () => {
    for (const n of ['get_song', 'new_song', 'add_instrument', 'write_drums', 'write_pattern', 'write_melody', 'set_orders', 'analyze_song', 'render_preview', 'export_wav']) {
      expect(GUIDE_SHORT, n).toContain(n)
    }
  })

  it('tool descriptions are written for an LLM: every argument has a description', () => {
    for (const t of createDefaultRegistry().defs()) {
      const props = (t.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {}
      for (const [k, v] of Object.entries(props)) expect(v.description, `${t.name}.${k}`).toBeTruthy()
    }
  })

  it('the generator rejects a missing marker or an overlong short guide', () => {
    expect(() => extractGuide('# no markers')).toThrow(/short:start/)
    expect(() => extractGuide(`<!-- short:start -->${'x'.repeat(1501)}<!-- short:end -->`)).toThrow(/1500/)
  })
})
describe('LLM guide for PS1 and Dreamcast', () => {
  it('the short guide names both new chips and stays within the limit', () => {
    expect(GUIDE_SHORT).toContain('PS1 (V1-V24 samples + reverb)')
    expect(GUIDE_SHORT).toContain('Dreamcast (V1-V64 samples + DSP)')
    expect(GUIDE_SHORT.length).toBeLessThanOrEqual(1500)
  })

  it('has a section per new chip with the voices config, the instrument kinds and the effect presets', () => {
    expect(GUIDE).toContain('### PlayStation (SPU)')
    expect(GUIDE).toContain('### Dreamcast (AICA)')
    const ps1 = GUIDE.slice(GUIDE.indexOf('### PlayStation (SPU)'), GUIDE.indexOf('### Dreamcast (AICA)'))
    const dc = GUIDE.slice(GUIDE.indexOf('### Dreamcast (AICA)'), GUIDE.indexOf('## Instruments and presets'))
    for (const s of ['"voices":24', 'psx-sample', 'attackExp', 'sustainLevel', 'SPU RAM', 'pmod', 'noise', 'studio-large', 'space-echo', 'half-echo', 'V13 kick', '22.05 kHz']) expect(ps1, s).toContain(s)
    for (const s of ['"voices":32', 'aica-sample', 'pcm16', 'adpcm', 'AICA RAM', 'flv', 'pitchDepth', 'chorus-hall', 'chorus-delay', 'microcode', 'dotted eighth']) expect(dc, s).toContain(s)
    for (const p of ['off', 'room', 'studio-small', 'studio-medium', 'studio-large', 'hall', 'half-echo', 'space-echo', 'echo', 'delay']) expect(ps1, p).toContain('`' + p + '`')
    for (const p of ['off', 'room', 'hall', 'plate', 'chorus', 'chorus-hall', 'delay', 'echo', 'chorus-delay']) expect(dc, p).toContain('`' + p + '`')
  })

  it('every PS1 and Dreamcast preset id in the guide exists in the preset banks', () => {
    const ids = new Set(Object.values(PRESET_BANKS).flatMap((bank) => bank.map((p) => p.id)))
    const named = [...GUIDE.matchAll(/`((?:ps1|dreamcast)\.[a-z0-9]+\.[a-z0-9-]+)`/g)].map((m) => m[1]!)
    expect(named.length).toBeGreaterThan(20)
    expect(named.filter((n) => !ids.has(n))).toEqual([])
    // the contract ids of the synthwave kit are all documented
    for (const id of ['lead.saw-detuned', 'lead.sync', 'pad.supersaw', 'pad.juno', 'bass.analog', 'bass.fm', 'bass.sub', 'pluck.arp', 'brass.synth-stab', 'epiano.dx', 'bell.dx', 'kick.linn', 'kick.808', 'snare.gated', 'snare.linn', 'clap.linn', 'hat.linn', 'openhat.linn', 'tom.linn', 'crash.linn']) {
      expect(GUIDE, `ps1.${id}`).toContain(`ps1.${id}`)
    }
  })

  it('the moods table has a row for every mood', () => {
    for (const id of MOOD_IDS) expect(GUIDE, id).toMatch(new RegExp('^\\| ' + id + ' \\|', 'm'))
  })

  it('the chip list of the guide and the effect row cover all seven chips', () => {
    expect(CHIP_IDS).toHaveLength(7)
    expect(GUIDE).toContain('PlayStation SPU, Dreamcast AICA')
    expect(GUIDE).toMatch(/\| `Exx` \| Effect send on \(01\) \/ off \(00\) for the channel: SNES echo, PS1 reverb, Dreamcast DSP/)
    expect(GUIDE).toContain('`synthwave`, `outrun`, `darkwave` and `dreamwave`')
    expect(GUIDE).toContain('{"V2":"ps1.lead.sync"}')
    expect(GUIDE).toContain('MIDI has 15 melodic channels')
  })
})
