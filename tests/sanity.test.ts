import { describe, expect, it } from 'vitest'
import { CORE_VERSION } from '../src/core'
import { TOOLS_VERSION } from '../src/tools'

describe('scaffold', () => {
  it('runs vitest and imports the pure-TS layers', () => {
    expect(CORE_VERSION).toBe(1)
    expect(TOOLS_VERSION).toBe(1)
  })
})
