// MCP server: Streamable HTTP on 127.0.0.1 (stateful sessions, one Server + transport per session),
// tools from the host (ToolBridge in the app), guide resources and prompts. No Electron import.
//
// Undo: the tool registry wraps each song-changing call in one transaction, so one MCP tools/call is
// one undo step already. No beginTurn/endTurn here (that would double-wrap).

import { randomUUID, timingSafeEqual, createHash } from 'node:crypto'
import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import type { McpStatus } from '../shared/mcp'
import type { ToolResult } from '../shared/tools'
import { GUIDE, GUIDE_SHORT } from '../tools/guideText'
import { type McpHost, PROMPTS, RESOURCES, buildPrompt, readResource } from './mcpContent'

export type { McpHost }

export interface McpHttpServerOptions {
  host: McpHost
  /** Port on 127.0.0.1; 0 picks a free one. */
  port: number
  /** Bearer token; null/undefined = no auth. */
  token?: string | null
  /** `instructions` of initialize (default GUIDE_SHORT). */
  instructions?: string
  /** Text of chiptune-studio://guide (default GUIDE). */
  guide?: string
  /** Called whenever running/error/session count change. */
  onStatus?: (status: McpStatus) => void
  /** Log sink (default: ignore). */
  log?: (msg: string) => void
}

const MAX_BODY = 64 * 1024 * 1024

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export function toMcpContent(r: ToolResult): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  return r.content.map((c) => (c.type === 'image' ? { type: 'image' as const, data: c.data, mimeType: c.mimeType } : { type: 'text' as const, text: c.text }))
}

interface Session {
  server: Server
  transport: StreamableHTTPServerTransport
}

export class McpHttpServer {
  private http: HttpServer | null = null
  private sessions = new Map<string, Session>()
  private error: string | undefined
  private port = 0
  private readonly opts: McpHttpServerOptions

  constructor(opts: McpHttpServerOptions) {
    this.opts = opts
  }

  // ------------------------------------------------------------ lifecycle

  getStatus(): McpStatus {
    const running = this.http !== null
    return { running, url: running ? this.url() : null, ...(this.error ? { error: this.error } : {}), sessions: this.sessions.size }
  }

  url(): string | null {
    return this.http ? `http://127.0.0.1:${this.port}/mcp` : null
  }

  sessionCount(): number {
    return this.sessions.size
  }

  /** Starts listening. Never throws: failures (EADDRINUSE) end up in `status.error`. */
  async start(): Promise<McpStatus> {
    if (this.http) return this.getStatus()
    this.error = undefined
    const http = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        this.opts.log?.(`MCP request failed: ${e instanceof Error ? e.message : String(e)}`)
        if (!res.headersSent) this.json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
        else res.end()
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (e: Error): void => reject(e)
        http.once('error', onError)
        http.listen(this.opts.port, '127.0.0.1', () => {
          http.off('error', onError)
          resolve()
        })
      })
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      this.error = err.code === 'EADDRINUSE' ? `Port ${this.opts.port} is already in use.` : `Could not start the MCP server: ${err.message}`
      this.opts.log?.(this.error)
      http.close()
      this.emit()
      return this.getStatus()
    }
    http.on('error', (e) => this.opts.log?.(`MCP http error: ${e.message}`))
    this.port = (http.address() as AddressInfo).port
    this.http = http
    this.emit()
    return this.getStatus()
  }

  async stop(): Promise<void> {
    const http = this.http
    this.http = null
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((s) => s.transport.close().catch(() => undefined)))
    if (http) {
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeAllConnections()
      })
    }
    this.error = undefined
    this.emit()
  }

  private emit(): void {
    this.opts.onStatus?.(this.getStatus())
  }

  // ------------------------------------------------------------ HTTP

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  private rpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
    this.json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers)
  }

  private hostAllowed(req: IncomingMessage): boolean {
    const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
    const host = (req.headers.host ?? '').toLowerCase()
    if (!allowed.includes(host)) return false
    const origin = req.headers.origin
    if (origin !== undefined) {
      try {
        const u = new URL(origin)
        if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return false
      } catch {
        return false
      }
    }
    return true
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.opts.token
    if (!token) return true
    const h = req.headers.authorization ?? ''
    const m = /^Bearer\s+(.+)$/i.exec(h)
    return m !== null && safeEqual(m[1]!.trim(), token)
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const b = chunk as Buffer
      size += b.length
      if (size > MAX_BODY) throw new Error('Request body too large')
      chunks.push(b)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/mcp') {
      this.json(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' })
      return
    }
    if (!this.hostAllowed(req)) {
      this.rpcError(res, 403, -32000, 'Forbidden: invalid Host or Origin header.')
      return
    }
    if (!this.authorized(req)) {
      this.rpcError(res, 401, -32001, 'Unauthorized: missing or invalid bearer token.', { 'WWW-Authenticate': 'Bearer' })
      return
    }
    const sid = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sid) ? sid[0] : sid

    if (req.method === 'POST') {
      let body: unknown
      try {
        body = await this.readBody(req)
      } catch (e) {
        this.rpcError(res, 400, -32700, `Parse error: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      if (sessionId) {
        const s = this.sessions.get(sessionId)
        if (!s) return this.rpcError(res, 404, -32001, 'Session not found. Initialize a new session.')
        await s.transport.handleRequest(req, res, body)
        return
      }
      const isInit = Array.isArray(body) ? body.some(isInitialize) : isInitialize(body)
      if (!isInit) return this.rpcError(res, 400, -32000, 'Bad Request: no session id. Send initialize first.')
      const s = this.createSession()
      await s.server.connect(s.transport)
      await s.transport.handleRequest(req, res, body)
      return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId) return this.rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required.')
      const s = this.sessions.get(sessionId)
      if (!s) return this.rpcError(res, 404, -32001, 'Session not found.')
      await s.transport.handleRequest(req, res)
      return
    }
    res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end()
  }

  // ------------------------------------------------------------ sessions

  private createSession(): Session {
    const server = this.createMcpServer()
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${this.port}`, `localhost:${this.port}`],
      onsessioninitialized: (id) => {
        this.sessions.set(id, session)
        this.emit()
      }
    })
    const session: Session = { server, transport }
    transport.onclose = () => {
      const id = transport.sessionId
      if (id && this.sessions.delete(id)) this.emit()
    }
    return session
  }

  private createMcpServer(): Server {
    const { host } = this.opts
    const guide = this.opts.guide ?? GUIDE
    const server = new Server(
      { name: 'chiptune-studio', version: '0.0.1' },
      { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: this.opts.instructions ?? GUIDE_SHORT }
    )

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: host.tools().map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object' as const, ...t.parameters } }))
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params
      try {
        const r = await host.execute(name, args ?? {}, extra.signal)
        return { content: toMcpContent(r), ...(r.isError ? { isError: true } : {}) }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `${name} failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    })

    server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: RESOURCES }))
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const uri = request.params.uri
      const r = await readResource(host, guide, uri, extra.signal)
      if (!r) throw new Error(`Unknown resource ${uri}`)
      return { contents: [{ uri, mimeType: r.mimeType, text: r.text }] }
    })

    server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: PROMPTS }))
    server.setRequestHandler(GetPromptRequestSchema, (request) => {
      const { name, arguments: args } = request.params
      const text = buildPrompt(name, args)
      if (text === null) throw new Error(`Unknown prompt ${name}`)
      const info = PROMPTS.find((p) => p.name === name)!
      return { description: info.description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] }
    })
    return server
  }
}

function isInitialize(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && (msg as { method?: unknown }).method === 'initialize'
}

export function createMcpHttpServer(opts: McpHttpServerOptions): McpHttpServer {
  return new McpHttpServer(opts)
}
