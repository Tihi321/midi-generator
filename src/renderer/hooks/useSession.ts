import { useSyncExternalStore } from 'react'
import { session } from '../state/session'

/**
 * Subscribe a component to the session. Returns the version number (changes on every document, history
 * or session-state change); read what you need from `session` during render.
 */
export function useSession(): number {
  return useSyncExternalStore(session.subscribe, session.getVersion)
}
