import { z } from 'zod'
import { defineTool } from '../registry'
import { obj, ok, songSession } from '../util'

export const playbackTools = [
  defineTool({
    name: 'play',
    group: 'playback',
    readOnly: true,
    noTransaction: true,
    description:
      "Start playing the song in the editor (the user hears it). Optionally start from an order row (and row); default: the cursor. loop:true repeats from the song's loop point. Playback follows live edits. Use stop to end it. You cannot hear it yourself: check the music with analyze_song and render_preview.",
    input: obj({
      order: z.number().int().min(0).optional().describe("Order row to start from (default: the cursor's)."),
      row: z.number().int().min(0).optional().describe('Row within that order (default 0).'),
      loop: z.boolean().optional().describe('Loop at the loop point (default true when the song has one).')
    }),
    handler: async (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      let from: { order: number; row?: number } | undefined
      if (args.order !== undefined || args.row !== undefined) {
        const order = args.order ?? session.cursor.order
        if (order >= song.orders.length) throw new Error(`Order ${order} not found: use 0..${song.orders.length - 1}.`)
        if (args.row !== undefined && args.row >= song.patternLength) throw new Error(`Row ${args.row} is outside the pattern: use 0..${song.patternLength - 1}.`)
        from = { order, row: args.row }
      }
      await ctx.services.audio.play(from, args.loop === undefined ? undefined : { loop: args.loop })
      return ok(`Playing from order ${from?.order ?? session.cursor.order}${from?.row ? `, row ${from.row}` : ''}${args.loop === false ? ' (no loop)' : ''}. Call stop to end playback.`)
    }
  }),

  defineTool({
    name: 'stop',
    group: 'playback',
    readOnly: true,
    noTransaction: true,
    description: 'Stop playback in the editor.',
    input: obj({}),
    handler: async (_args, ctx) => {
      await ctx.services.audio.stop()
      return ok('Playback stopped.')
    }
  })
]
