import type { LlmModelInfo } from '../../shared/agent'

/** tools / vision (/ local) badges of a model; `compact` leaves out the local/remote one (the Models tab rows). */
export function Badges({ m, compact }: { m: Pick<LlmModelInfo, 'tools' | 'vision' | 'local'> | undefined; compact?: boolean }) {
  if (!m) return null
  return (
    <span className="chat-badges">
      <span className={`badge ${m.tools ? 'on' : 'off'}`} title={m.tools ? 'Native tool calling' : 'No native tool calling: the agent uses JSON actions (slower, less reliable)'}>
        {m.tools ? 'tools' : 'json'}
      </span>
      <span className={`badge ${m.vision ? 'on' : 'off'}`} title={m.vision ? 'Can look at images: sees the piano-roll preview from render_preview' : 'Cannot look at images: works from text only'}>
        {m.vision ? 'vision' : 'no vision'}
      </span>
      {!compact && (
        <span className="badge" title={m.local ? 'Runs on this machine' : 'Remote API'}>
          {m.local ? 'local' : 'remote'}
        </span>
      )}
    </span>
  )
}
