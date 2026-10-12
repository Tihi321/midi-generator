import { McpHttpServer, type McpHttpServerOptions } from '../../src/main/mcp'
import { SongSession, createDefaultRegistry, createMemoryToolServices, createToolHost } from '../../src/tools'

/** An in-memory tool host over the REAL default registry, a SongSession and in-memory services. */
export function memoryHost() {
  const session = new SongSession()
  const services = createMemoryToolServices()
  const registry = createDefaultRegistry()
  const host = createToolHost(registry, () => ({ session, services }))
  return { session, services, registry, host }
}

export async function startServer(opts: Partial<McpHttpServerOptions> = {}) {
  const mem = memoryHost()
  const server = new McpHttpServer({ host: mem.host, port: 0, ...opts })
  const status = await server.start()
  if (!status.running) throw new Error(`server did not start: ${status.error}`)
  return { ...mem, server, url: new URL(status.url!), port: Number(new URL(status.url!).port) }
}
