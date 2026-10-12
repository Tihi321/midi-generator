// The app-wide song session: the tracker, piano roll, chat panel and the tool bridge all drive this one
// object, so LLM/MCP edits and manual edits share one undo history.

import { SongSession } from '../../tools/session'

export const session = new SongSession()
