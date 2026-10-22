// The headless port: --port, CHIPTUNE_STUDIO_MCP_PORT, default.

import { describe, expect, it } from 'vitest'
import { DEFAULT_HEADLESS_PORT, headlessPort, parseCli } from '../../src/main/cli'

describe('headlessPort', () => {
  it('uses the default without flag or env', () => {
    expect(headlessPort(parseCli(['x', '--mcp-only']), {})).toEqual({ port: 7458 })
    expect(DEFAULT_HEADLESS_PORT).toBe(7458)
  })
  it('uses the env var', () => {
    expect(headlessPort({}, { CHIPTUNE_STUDIO_MCP_PORT: '7500' })).toEqual({ port: 7500 })
  })
  it('--port wins over the env var', () => {
    const cli = parseCli(['x', '--mcp-only', '--port', '7600'])
    expect(headlessPort(cli, { CHIPTUNE_STUDIO_MCP_PORT: '7500' })).toEqual({ port: 7600 })
  })
  it('an invalid env value warns and falls back to the default', () => {
    for (const bad of ['abc', '70000', '-1', '75.5']) {
      const r = headlessPort({}, { CHIPTUNE_STUDIO_MCP_PORT: bad })
      expect(r.port).toBe(7458)
      expect(r.warning).toContain('CHIPTUNE_STUDIO_MCP_PORT')
    }
  })
})
