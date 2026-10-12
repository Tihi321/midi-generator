// chiptune-studio-mcp: stdio -> HTTP shim for MCP clients that only support stdio (e.g. Claude Desktop).
// Env: CHIPTUNE_STUDIO_MCP_URL (default http://127.0.0.1:7458/mcp), CHIPTUNE_STUDIO_MCP_TOKEN (optional bearer token).
// Built by `yarn build:mcp` to out/mcp-stdio/index.js.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createRelay } from './relay'

async function main(): Promise<void> {
  const relay = createRelay({
    url: process.env['CHIPTUNE_STUDIO_MCP_URL'],
    token: process.env['CHIPTUNE_STUDIO_MCP_TOKEN'],
    stdio: new StdioServerTransport()
  })
  await relay.start()
  const stop = (): void => void relay.close().finally(() => process.exit(0))
  process.stdin.on('end', stop)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((e: unknown) => {
  process.stderr.write(`chiptune-studio-mcp: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
