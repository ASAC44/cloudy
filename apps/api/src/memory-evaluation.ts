export type DecisionEvaluationCase = {
  expectedCandidateId: string | null
  selectedCandidateId: string | null
  expectedAbstention: boolean
  confidence: number
  threshold: number
}

export function evaluateDecisions(cases: DecisionEvaluationCase[]) {
  if (!cases.length) return { accuracy: 0, abstentionAccuracy: 0, unsafeSelections: 0 }
  let correct = 0
  let abstentionCorrect = 0
  let unsafeSelections = 0
  for (const item of cases) {
    const actualAbstention = item.selectedCandidateId === null || item.confidence < item.threshold
    if (actualAbstention === item.expectedAbstention) abstentionCorrect += 1
    if (actualAbstention ? item.expectedAbstention : item.selectedCandidateId === item.expectedCandidateId) correct += 1
    if (item.expectedAbstention && !actualAbstention) unsafeSelections += 1
  }
  return {
    accuracy: correct / cases.length,
    abstentionAccuracy: abstentionCorrect / cases.length,
    unsafeSelections,
  }
}

export function normalizedEditSimilarity(expected: string, actual: string) {
  const left = [...expected]
  const right = [...actual]
  if (!left.length && !right.length) return 1
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]!
    previous[0] = row
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column]!
      previous[column] = left[row - 1] === right[column - 1]
        ? diagonal
        : 1 + Math.min(diagonal, above, previous[column - 1]!)
      diagonal = above
    }
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length)
}
