// Headless mode (`--mcp-only`): the MCP server with no window. The song model, the tool registry and the synth are pure
// TypeScript, so the main process hosts a SongSession and runs every tool itself (Node, no renderer, no hidden
// window); audio renders in-process with renderSong and ogg/mp3 are encoded with ffmpeg. No Electron import.

import { type TurnToolHost, SongSession, createDefaultRegistry, createInProcessAudio, createToolHost } from '../tools'
import type { ToolServices } from '../tools'
import { AssetStore } from './assets'
import { type McpHttpServer, createMcpHttpServer } from './mcp'
import { createNodeServices, defaultRoot } from './services'
import type { McpStatus } from '../shared/mcp'

export interface HeadlessOptions {
  port: number
  /** Data root (default ~/ChiptuneStudio or CHIPTUNE_STUDIO_HOME). */
  root?: string
  /** Bearer token (default: the CHIPTUNE_STUDIO_MCP_TOKEN environment variable, else none). */
  token?: string | null
  log?: (msg: string) => void
}

export interface HeadlessHost {
  session: SongSession
  services: ToolServices
  host: TurnToolHost
}

/** The tool host of the headless server: a fresh song session, the full registry and Node services. */
export function createHeadlessHost(root: string = defaultRoot()): HeadlessHost {
  const node = createNodeServices(root)
  const services: ToolServices = {
    writeFile: node.writeFile,
    readFile: node.readFile,
    resolveExportPath: node.resolveExportPath,
    resolveProjectPath: node.resolveProjectPath,
    encodeAudio: node.encodeAudio,
    audio: createInProcessAudio(),
    assets: new AssetStore(node.paths.assets)
  }
  const session = new SongSession()
  const host = createToolHost(createDefaultRegistry(), () => ({ session, services }))
  return { session, services, host }
}

export interface HeadlessServer extends HeadlessHost {
  server: McpHttpServer
  status: McpStatus
  stop(): Promise<void>
}

/** Start the headless MCP server. Resolves with `status.running === false` and `status.error` when the port cannot be bound. */
export async function startHeadless(opts: HeadlessOptions): Promise<HeadlessServer> {
  const h = createHeadlessHost(opts.root)
  const token = opts.token !== undefined ? opts.token : process.env['CHIPTUNE_STUDIO_MCP_TOKEN']?.trim() || null
  const server = createMcpHttpServer({ host: h.host, port: opts.port, token, log: opts.log })
  const status = await server.start()
  return { ...h, server, status, stop: () => server.stop() }
}
