// MCP guide content: resources and prompts. No Electron, no SDK imports (pure data + host calls).

import type { ToolHost, ToolResult } from '../shared/tools'

/** What the MCP server needs from a tool host (the ToolBridge, or an in-memory host in tests). */
export type McpHost = Pick<ToolHost, 'tools'> & {
  execute(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>
}

export interface McpResourceInfo {
  uri: string
  name: string
  description: string
  mimeType: string
}

export const RESOURCES: McpResourceInfo[] = [
  { uri: 'chiptune-studio://guide', name: 'guide', description: 'How to drive Chiptune Studio: workflow, chips, tracker text, effects, moods, export. Read this first.', mimeType: 'text/markdown' },
  { uri: 'chiptune-studio://song', name: 'song', description: 'Summary of the open song (chip, timing, key, order list, channels, instruments).', mimeType: 'text/plain' },
  { uri: 'chiptune-studio://presets', name: 'presets', description: 'Instrument presets of the open song\'s chip (ids, roles, channels).', mimeType: 'text/plain' },
  { uri: 'chiptune-studio://assets', name: 'assets', description: 'The asset library: saved songs, motifs and instruments (id, kind, chip, key, moods, tags). Use with get_asset, place_asset and set_style_reference.', mimeType: 'text/plain' }
]

function textOf(r: ToolResult): string {
  return r.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

/** Reads a resource; returns null for unknown URIs. */
export async function readResource(host: McpHost, guide: string, uri: string, signal?: AbortSignal): Promise<{ mimeType: string; text: string } | null> {
  const info = RESOURCES.find((r) => r.uri === uri)
  if (!info) return null
  if (uri === 'chiptune-studio://guide') return { mimeType: info.mimeType, text: guide }
  const tool = uri.endsWith('song') ? 'get_song' : uri.endsWith('assets') ? 'list_assets' : 'list_presets'
  const r = await host.execute(tool, {}, signal)
  return { mimeType: info.mimeType, text: textOf(r) }
}

// ---------------------------------------------------------------- prompts

export interface McpPromptArg {
  name: string
  description: string
  required: boolean
}
export interface McpPromptInfo {
  name: string
  description: string
  arguments: McpPromptArg[]
}

export const PROMPTS: McpPromptInfo[] = [
  {
    name: 'compose_track',
    description: 'Compose a game-music track in a mood for a chip, step by step.',
    arguments: [
      { name: 'mood', description: 'Mood, e.g. "heroic", "spooky dungeon", "chill shop", "boss battle", "synthwave".', required: true },
      { name: 'chip', description: 'Chip: nes, gb (8-bit), genesis, snes, pce (16-bit), ps1 or dreamcast (sample chips). Default: the mood\'s chip (ps1 for synthwave and darkwave, dreamcast for outrun and dreamwave, snes for calm moods, genesis for chill, shop and castle, nes otherwise).', required: false },
      { name: 'length', description: 'Length, e.g. "32 bars" or "90 seconds". Default: the mood recipe\'s arrangement.', required: false }
    ]
  },
  {
    name: 'remix_to_chip',
    description: 'Re-create the open song for another chip (convert it, then fix what the new chip cannot do).',
    arguments: [{ name: 'chip', description: 'Target chip: nes, gb, genesis, snes, pce, ps1 or dreamcast.', required: true }]
  },
  {
    name: 'match_style',
    description: 'Compose in the style of a saved library asset (a song, motif or instrument): reads its style context and writes new music that matches it.',
    arguments: [
      { name: 'asset', description: 'Asset id or exact name from the library (chiptune-studio://assets, list_assets).', required: true },
      { name: 'mood', description: 'Optional mood for the new music, e.g. "chill shop". Default: the mood of the asset.', required: false }
    ]
  }
]

/** Builds the prompt text, or null for an unknown prompt. Throws for a missing required argument. */
export function buildPrompt(name: string, args: Record<string, string | undefined> = {}): string | null {
  const info = PROMPTS.find((p) => p.name === name)
  if (!info) return null
  for (const a of info.arguments) if (a.required && !args[a.name]?.trim()) throw new Error(`Missing required argument "${a.name}" for prompt ${name}.`)
  switch (name) {
    case 'compose_track': {
      const mood = args['mood']!.trim()
      const chip = args['chip']?.trim() || undefined // omitted: the mood picks the chip (same as the compose_track tool)
      const length = args['length']?.trim()
      return [
        `Compose a ${mood} game-music track ${chip ? `for the ${chip} chip` : 'on the chip that suits the mood'}${length ? `, about ${length} long` : ''}.`,
        '',
        'Follow this workflow (read chiptune-studio://guide if you have not yet):',
        '1. Call get_song to see whether a song is already open. Only call new_song if the user wants a new one or the open song is empty.',
        `2. Call get_mood_recipe {"mood":"${mood}"${chip ? `,"chip":"${chip}"` : ''}} for BPM, key, scales, progressions, arrangement and techniques${chip ? '' : ' (the channel plan shown is for the open song\'s chip; pass "chip" to see another one)'}. Call suggest_progression to get the chords in your key.`,
        `3. Call new_song {${chip ? `"chip":"${chip}",` : ''}"mood":"<mood id>"} (add name, bpm, key or scale to override the recipe).`,
        '4. Call add_instrument for each voice (preset = a role such as lead, arp, bass, pad, or a preset id from list_presets; pass channel).',
        '5. Write section A first: write_drums (get_drum_pattern has grooves), then the bass and harmony with write_pattern, then the lead with write_melody. 64 rows or fewer per call.',
        `6. Build the order list with set_orders for the arrangement${length ? ` (fit it to ${length})` : ''} and set the loop with set_loop. Vary repeats with duplicate_order or copy_pattern (transpose) and edit them.`,
        '7. Call analyze_song and fix chip violations, clashes and stray notes. Call render_preview and check rhythm, range and structure.',
        '8. Tell the user what you made; export with export_wav (loops, stems) only if asked.'
      ].join('\n')
    }
    case 'remix_to_chip': {
      const chip = args['chip']!.trim()
      return [
        `Re-create the open song for the ${chip} chip.`,
        '',
        '1. Call get_song and read the music (read_pattern for each order row) so you know the parts: bass, harmony, lead, drums.',
        `2. Call convert_chip {"chip":"${chip}"} (one undo step; undo brings the original back). It maps channels by role (bass, lead, harmony, drums), replaces every instrument with the target chip's preset for the same role, moves notes by octaves into range, drops effects the target cannot play, and drops channels the target does not have (the report lists each one). Tempo, orders, loop, key and pattern length are kept. READ THE REPORT.`,
        '3. Call analyze_song and fix every issue it reports (note ranges, channel limits, unsupported effects).',
        "4. Instrument macros and hand-made patches are NOT carried over: re-pick or edit instruments (list_presets, add_instrument, update_instrument) and re-voice dropped parts into the remaining channels with that chip's idioms (get_mood_recipe, list_chips): arpeggios (0xy) for chords on pulse chips, duty changes, FM/sample timbres, echo on SNES.",
        '5. Call render_preview, check rhythm, range and structure, and tell the user what had to change.'
      ].join('\n')
    }
    case 'match_style': {
      const asset = args['asset']!.trim()
      const mood = args['mood']?.trim()
      return [
        `Compose new music in the style of the library asset "${asset}"${mood ? `, with the mood "${mood}"` : ''}.`,
        '',
        `1. Call set_style_reference {"ids":["${asset}"]} so the song remembers the reference, then get_style_context: it shows the reference's chip, tempo and groove, key and scale, instruments, drum steps, chord progression, sample tracker rows and the user's notes. Call get_asset {"id":"${asset}"} for more rows or its preview image.`,
        `2. Call get_song, then new_song for the same chip (or the chip the user asks for) with a similar tempo and the reference's key/scale${mood ? `, or take them from get_mood_recipe {"mood":"${mood}"} and keep the reference's feel` : ''}.`,
        '3. Add instruments like the reference uses (same roles/presets via add_instrument; place_asset adds a saved instrument or motif directly).',
        '4. Write drums with the same groove idea, then bass, harmony and lead with the same density and register. Match the feel; write new notes, do not copy the reference.',
        '5. Build the order list, set_loop, then analyze_song and render_preview and fix what they report. Tell the user how the result matches the reference.'
      ].join('\n')
    }
  }
  return null
}
