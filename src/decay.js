// SPDX-License-Identifier: Apache-2.0
'use strict'
// SPDX-License-Identifier: Apache-2.0

const fs = require('fs').promises
const p  = require('./paths')
const { readMemory, patchMemory, archiveMemory, listActiveFiles, updateSalienceMap } = require('./write')
const git = require('./git')

// Run the Salience Decay Engine for one cycle. Mandatory: call AFTER Gardener.
async function runDecay(baseDir, agentId, config) {
  const root    = p.agentRoot(baseDir, agentId)
  const today   = todayUTC()
  const files   = await listActiveFiles(baseDir, agentId, ['L1', 'L2', 'L3'])
  const updates = []
  const toArchive = []

  for (const { filePath, frontMatter } of files) {
    const accessedToday = frontMatter.last_accessed &&
      frontMatter.last_accessed.slice(0, 10) === today

    let newSalience
    if (accessedToday) {
      newSalience = clamp(frontMatter.salience + config.reinforcement_delta, 0.0, 1.0)
    } else {
      newSalience = frontMatter.salience * (1 - frontMatter.decay_rate)
    }

    if (newSalience < config.archive_threshold) {
      toArchive.push({ filePath, id: frontMatter.id, salience: newSalience })
    } else {
      updates.push({ filePath, id: frontMatter.id, salience: newSalience })
    }
  }

  // Archive below-threshold memories
  for (const { filePath, id, salience } of toArchive) {
    await archiveMemory(baseDir, agentId, filePath, id, salience)
  }

  // Write updated salience values in batch
  for (const { filePath, salience } of updates) {
    await patchMemory(filePath, { salience })
  }

  // Write salience map
  const salienceMap = {}
  for (const { id, salience } of updates) {
    salienceMap[id] = salience
  }
  const existingMap = JSON.parse(
    await fs.readFile(p.salienceMapPath(baseDir, agentId), 'utf8').catch(() => '{}')
  )
  const mergedMap = { ...existingMap, ...salienceMap }
  // Remove archived entries from salience map
  for (const { id } of toArchive) delete mergedMap[id]
  await fs.writeFile(p.salienceMapPath(baseDir, agentId), JSON.stringify(mergedMap), 'utf8')

  const summary = { archived: toArchive.length, updated: updates.length }

  // Batch commit all decay updates in a single commit
  if (updates.length > 0 || toArchive.length > 0) {
    await git.gitCommit(root,
      `perlith: decay archived=${summary.archived} updated=${summary.updated}`, ['.'])
  }

  return summary
}

// Recency score used by retrieval pipeline (extracted here to share the formula)
function recencyScore(lastAccessed, now, halflifeDays) {
  if (!lastAccessed) return 0
  const ageMs   = now - new Date(lastAccessed).getTime()
  const ageDays = ageMs / 86_400_000
  const k       = Math.log(2) / halflifeDays
  return Math.exp(-k * ageDays)
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val))
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

module.exports = { runDecay, recencyScore }
