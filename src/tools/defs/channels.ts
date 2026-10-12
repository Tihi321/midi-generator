import { z } from 'zod'
import { createChannelCommand, requireChannelIndex } from '../../core'
import { defineTool } from '../registry'
import { CHANNEL_DESC, channelRef, obj, ok, songSession } from '../util'

export const channelTools = [
  defineTool({
    name: 'update_channel',
    group: 'channels',
    description:
      'Change a channel\'s mixer/editor settings: name, mute, pan (-1 left .. 1 right; chips quantize it, NES/GB-wave/mono channels may refuse in strict songs), trim (dB, -48..12) and the number of effect columns (1-4). Muted channels are silent in playback and exports. Example: {"channel":"TR","trim":-2} or {"channel":"P2","muted":true}.',
    input: obj({
      channel: channelRef.describe(CHANNEL_DESC),
      name: z.string().min(1).optional().describe('New channel name.'),
      muted: z.boolean().optional().describe('Silence the channel.'),
      pan: z.number().min(-1).max(1).optional().describe('-1 = left, 0 = centre, 1 = right.'),
      trim: z.number().min(-48).max(12).optional().describe('Gain in dB.'),
      fxColumns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional().describe('Effect columns shown (and allowed per cell on this channel).')
    }),
    handler: ({ channel, ...patch }, ctx) => {
      const session = songSession(ctx)
      const i = requireChannelIndex(session.song, channel)
      if (Object.keys(patch).length === 0) return ok('Nothing to change: pass name, muted, pan, trim or fxColumns.')
      session.execute(createChannelCommand(session.song, i, patch))
      const c = session.song.channels[i]!
      return ok(`Channel ${c.id} "${c.name}": ${c.muted ? 'muted' : 'active'}, pan ${c.pan ?? 0}, trim ${c.trim ?? 0} dB, ${c.fxColumns} effect column(s).`)
    }
  })
]
