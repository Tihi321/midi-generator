// Command line of the app. No Electron import (testable).
//
//   --mcp-only [--port N]                      headless MCP server, no window (port: --port, else env CHIPTUNE_STUDIO_MCP_PORT, else 7458)
//   --open <file.ctune> [--export-to <file>] [--export-format ogg|wav|mp3]
//                                              open a song in the window; every save also exports the looping audio
//
// `electron . --open x.ctune` (dev) and `<exe> --open x.ctune` (packaged) both work: flags are found anywhere in argv.

import { extname, isAbsolute, resolve } from 'node:path'
import type { OpenSongRequest } from '../shared/ipc'

export const DEFAULT_HEADLESS_PORT = 7458

export interface CliOptions {
  mcpOnly: boolean
  /** --port, when valid. */
  port?: number
  /** Set when --open was given. */
  open?: OpenSongRequest
  /** Problems with the arguments (printed as warnings, never fatal). */
  warnings: string[]
}

const VALUE_FLAGS = ['--port', '--open', '--export-to', '--export-format']

/**
 * Flag values by flag name. `--flag value` and `--flag=value` both work. The argv of a second instance comes from
 * Chromium, which moves every switch in front of the positional arguments (`--open --export-to <app dir> a.ctune b.ogg`):
 * when a value flag has no value right behind it, the positional arguments are matched to the value flags in order
 * (extra leading positionals, like the app folder in `electron . ...`, are dropped).
 */
function collectValues(args: string[]): Map<string, string | undefined> {
  const values = new Map<string, string | undefined>()
  let reordered = false
  args.forEach((a, i) => {
    const eq = a.indexOf('=')
    if (eq > 0 && VALUE_FLAGS.includes(a.slice(0, eq))) {
      values.set(a.slice(0, eq), a.slice(eq + 1) || undefined)
    } else if (VALUE_FLAGS.includes(a)) {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) values.set(a, next)
      else {
        values.set(a, undefined)
        reordered = true
      }
    }
  })
  if (reordered) {
    const flags = args.filter((a) => VALUE_FLAGS.includes(a))
    const positional = args.filter((a) => !a.startsWith('--'))
    const mine = positional.slice(Math.max(0, positional.length - flags.length))
    flags.forEach((f, i) => values.set(f, mine[i]))
  }
  return values
}

function valueOf(values: Map<string, string | undefined>, flag: string): { found: boolean; value?: string } {
  return values.has(flag) ? { found: true, value: values.get(flag) } : { found: false }
}

/** Headless port: `--port` wins, else CHIPTUNE_STUDIO_MCP_PORT, else the default. A bad env value warns and falls back. */
export function headlessPort(cli: Pick<CliOptions, 'port'>, env: NodeJS.ProcessEnv = process.env): { port: number; warning?: string } {
  if (cli.port !== undefined) return { port: cli.port }
  const raw = env.CHIPTUNE_STUDIO_MCP_PORT
  if (raw === undefined || raw === '') return { port: DEFAULT_HEADLESS_PORT }
  const n = Number(raw)
  if (Number.isInteger(n) && n >= 0 && n <= 65535) return { port: n }
  return { port: DEFAULT_HEADLESS_PORT, warning: `CHIPTUNE_STUDIO_MCP_PORT needs a number 0..65535 (got "${raw}"); using the default.` }
}

/** Format for an export file: the explicit flag, else the extension, else ogg. */
export function exportFormatFor(path: string, given?: string): 'ogg' | 'wav' | 'mp3' {
  const g = given?.toLowerCase()
  if (g === 'ogg' || g === 'wav' || g === 'mp3') return g
  const ext = extname(path).toLowerCase()
  return ext === '.wav' ? 'wav' : ext === '.mp3' ? 'mp3' : 'ogg'
}

/** Parse process.argv (or the argv of a second instance). Relative paths resolve against `cwd`. */
export function parseCli(argv: string[], cwd: string = process.cwd()): CliOptions {
  const args = argv.slice(1)
  const warnings: string[] = []
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(cwd, p))
  const out: CliOptions = { mcpOnly: args.includes('--mcp-only'), warnings }
  const values = collectValues(args)

  const port = valueOf(values, '--port')
  if (port.found) {
    const n = Number(port.value)
    if (Number.isInteger(n) && n >= 0 && n <= 65535) out.port = n
    else warnings.push(`--port needs a number 0..65535 (got "${port.value ?? ''}"); using the default.`)
  }

  const open = valueOf(values, '--open')
  if (open.found) {
    if (!open.value) warnings.push('--open needs the path of a .ctune file.')
    else {
      const req: OpenSongRequest = { path: abs(open.value) }
      const to = valueOf(values, '--export-to')
      const fmt = valueOf(values, '--export-format')
      if (fmt.found && !['ogg', 'wav', 'mp3'].includes((fmt.value ?? '').toLowerCase())) warnings.push(`--export-format must be ogg, wav or mp3 (got "${fmt.value ?? ''}").`)
      if (to.found) {
        if (!to.value) warnings.push('--export-to needs a file path.')
        else {
          req.exportTo = abs(to.value)
          req.exportFormat = exportFormatFor(req.exportTo, fmt.value)
        }
      }
      out.open = req
    }
  }
  return out
}
