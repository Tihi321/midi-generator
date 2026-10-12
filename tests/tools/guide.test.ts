import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractGuide, renderGuideModule } from '../../scripts/gen-guide.mjs'
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
