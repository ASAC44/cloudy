export type EventDecisionV1 = {
  match: boolean
  title: string
  summary: string
  risk: 'low' | 'medium' | 'high'
  warnings: string[]
  draft: string | null
}
