import { z } from 'zod'
import { defineTool } from '../registry'
import { obj, ok, plural, songSession } from '../util'

const countArg = z.number().int().min(1).max(50).optional().describe('How many steps (default 1).')

export const historyTools = [
  defineTool({
    name: 'undo',
    group: 'history',
    noTransaction: true,
    description:
      'Undo the last change(s) to the song (each tool call that changes the song is one step). Reports what was undone. Inside an agent turn it never undoes anything from before the turn.',
    input: obj({ steps: countArg }),
    handler: ({ steps }, ctx) => {
      const session = songSession(ctx)
      const labels: string[] = []
      for (let i = 0; i < (steps ?? 1); i++) {
        const label = session.undoLabel()
        if (!session.undo()) break
        labels.push(label ?? 'change')
      }
      if (labels.length === 0) return ok('Nothing to undo.')
      return ok(`Undid ${plural(labels.length, 'step')}: ${labels.join(', ')}.${session.canUndo() ? '' : ' (no more undo steps)'}`)
    }
  }),

  defineTool({
    name: 'redo',
    group: 'history',
    noTransaction: true,
    description: 'Redo change(s) that were undone (only possible until a new change is made).',
    input: obj({ steps: countArg }),
    handler: ({ steps }, ctx) => {
      const session = songSession(ctx)
      const labels: string[] = []
      for (let i = 0; i < (steps ?? 1); i++) {
        const label = session.redoLabel()
        if (!session.redo()) break
        labels.push(label ?? 'change')
      }
      if (labels.length === 0) return ok('Nothing to redo.')
      return ok(`Redid ${plural(labels.length, 'step')}: ${labels.join(', ')}.`)
    }
  })
]
