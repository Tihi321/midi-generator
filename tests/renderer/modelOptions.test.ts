import { describe, expect, it } from 'vitest'
import type { LlmModelInfo } from '../../src/shared/agent'
import { modelOptions } from '../../src/renderer/state/modelOptions'

const m = (provider: string, id: string, shown: boolean): LlmModelInfo => ({
  ref: `${provider}/${id}`,
  provider,
  id,
  label: id,
  tools: true,
  vision: false,
  local: false,
  available: true,
  shown,
  source: 'config',
  free: false
})

describe('modelOptions', () => {
  const all = [m('a', 'x', true), m('b', 'y', false), m('a', 'z', false), m('b', 'w', true)]

  it('keeps shown models grouped by provider', () => {
    const g = modelOptions(all, null)
    expect(g.map((x) => [x.provider, x.models.map((r) => r.id)])).toEqual([
      ['a', ['x']],
      ['b', ['w']]
    ])
  })

  it('adds the current ref even when hidden', () => {
    const g = modelOptions(all, 'a/z')
    expect(g[0]!.models.map((r) => r.id)).toEqual(['x', 'z'])
  })

  it('skips groups with nothing to show', () => {
    expect(modelOptions([m('a', 'x', false)], '')).toEqual([])
  })
})
