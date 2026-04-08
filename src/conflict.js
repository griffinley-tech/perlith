'use strict'
// SPDX-License-Identifier: Apache-2.0
// conflict.js — Post-MMR conflict detection (shared-namespace)
// AC-17: confidence wins, shared tie-break. AC-18: runs after mmrRerank.
// AC-19: subject-match only, not semantic similarity.

/**
 * detectConflicts(rankedResults) → rankedResults (mutated with _conflict_suppressed flags)
 * Groups by frontMatter.subject. For each group with >1 result and differing object values,
 * winner = highest confidence_score; tie-break: namespace==='shared' wins.
 * Losers get _conflict_suppressed:true + _conflicting_fact_id: winner.id.
 * Returns full array in original order; caller decides whether to filter suppressed facts.
 */
function detectConflicts(rankedResults) {
  // Group by subject (AC-19: exact subject match only)
  const groups = new Map()
  for (const result of rankedResults) {
    const subject = result.frontMatter?.subject
    if (!subject) continue
    if (!groups.has(subject)) groups.set(subject, [])
    groups.get(subject).push(result)
  }
  // Detect conflicts within each group
  for (const [, group] of groups) {
    if (group.length < 2) continue
    // Check if there are differing object values
    const objects = new Set(group.map(r => r.frontMatter.object).filter(Boolean))
    if (objects.size < 2) continue
    // Sort: highest confidence first; tie-break: shared namespace wins
    const sorted = [...group].sort((a, b) => {
      const confDiff = (b.frontMatter.confidence_score ?? 0) - (a.frontMatter.confidence_score ?? 0)
      if (confDiff !== 0) return confDiff
      // Tie-break: shared namespace wins (AC-17)
      const aShared = a.frontMatter.namespace === 'shared' ? 1 : 0
      const bShared = b.frontMatter.namespace === 'shared' ? 1 : 0
      return bShared - aShared
    })
    const winner = sorted[0]
    for (let i = 1; i < sorted.length; i++) {
      // Only suppress if this result's object differs from winner's
      if (sorted[i].frontMatter.object !== winner.frontMatter.object) {
        sorted[i]._conflict_suppressed = true
        sorted[i]._conflicting_fact_id = winner.frontMatter.id
      }
    }
  }
  return rankedResults
}

module.exports = { detectConflicts }
