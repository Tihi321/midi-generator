import type { LlmModelInfo } from '../../shared/agent'

export interface ModelGroup {
  provider: string
  models: LlmModelInfo[]
}

/** The chat dropdown's models: the ticked ones plus the one in use, grouped by provider (first appearance order). */
export function modelOptions(models: LlmModelInfo[], current: string | null | undefined): ModelGroup[] {
  const groups: ModelGroup[] = []
  for (const m of models) {
    if (!m.shown && m.ref !== current) continue
    let g = groups.find((x) => x.provider === m.provider)
    if (!g) groups.push((g = { provider: m.provider, models: [] }))
    g.models.push(m)
  }
  return groups
}
