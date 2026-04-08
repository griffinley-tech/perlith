'use strict'
// SPDX-License-Identifier: Apache-2.0

const fs = require('fs').promises
const p  = require('./paths')
const { readMemory, patchMemory, listActiveFiles } = require('./write')
const git = require('./git')

// Run associative linking for a newly written semantic file.
// Called synchronously after every new L2 file creation.
async function linkNewFile(baseDir, agentId, newFilePath, config) {
  const root = p.agentRoot(baseDir, agentId)
  const { frontMatter: newMeta } = await readMemory(newFilePath)
  const newTags = new Set(newMeta.tags || [])
  if (newTags.size === 0) return []

  // Load inverted index to find candidate files sharing tags
  let index = {}
  try { index = JSON.parse(await fs.readFile(p.invertedIndexPath(baseDir, agentId), 'utf8')) }
  catch { return [] }

  // Gather candidate IDs (files sharing ≥1 tag with new file)
  const candidateIds = new Set()
  for (const tag of newTags) {
    for (const id of (index[tag] || [])) {
      if (id !== newMeta.id) candidateIds.add(id)
    }
  }

  if (candidateIds.size === 0) return []

  // Score candidates by shared tag count
  const allFiles = await listActiveFiles(baseDir, agentId, ['L2', 'L3'])
  const scored   = []

  for (const id of candidateIds) {
    const file = allFiles.find(f => f.frontMatter.id === id)
    if (!file || file.frontMatter.status !== 'active') continue
    const fileTags   = new Set(file.frontMatter.tags || [])
    const sharedTags = [...newTags].filter(t => fileTags.has(t)).length
    if (sharedTags >= config.linker_min_shared_tags) {
      scored.push({ id, filePath: file.filePath, frontMatter: file.frontMatter, sharedTags })
    }
  }

  if (scored.length === 0) return []

  scored.sort((a, b) => b.sharedTags - a.sharedTags)
  const toLink = selectLinks(scored, newMeta.linked || [], config.linker_max_links)

  if (toLink.length === 0) return []

  // Write bidirectional links
  const newLinked = [...(newMeta.linked || [])]
  const linkedIds = []

  for (const candidate of toLink) {
    // Add link in new file → candidate direction
    if (!newLinked.includes(candidate.id)) newLinked.push(candidate.id)
    linkedIds.push(candidate.id)

    // Add link in candidate → new file direction
    const cMeta   = candidate.frontMatter
    const cLinked = [...(cMeta.linked || [])]
    if (!cLinked.includes(newMeta.id)) {
      if (cLinked.length >= config.linker_max_links) {
        // Replace lowest-salience existing link if new candidate has more shared tags
        const minIdx = cLinked.reduce((minI, id, i, arr) => {
          const existing = scored.find(s => s.id === arr[i])
          const minExisting = scored.find(s => s.id === arr[minI])
          return (existing?.sharedTags || 0) < (minExisting?.sharedTags || 0) ? i : minI
        }, 0)
        cLinked[minIdx] = newMeta.id
      } else {
        cLinked.push(newMeta.id)
      }
      await patchMemory(candidate.filePath, { linked: cLinked })
    }
  }

  await patchMemory(newFilePath, { linked: newLinked })

  await git.gitCommit(root,
    `perlith: link ${newMeta.id} <-> [${linkedIds.join(',')}]`, ['.'])

  return linkedIds
}

// Select which candidates to link, respecting the max_links cap on the new file
function selectLinks(scored, existingLinks, maxLinks) {
  const available = maxLinks - existingLinks.length
  if (available <= 0) return []
  return scored.slice(0, available)
}

module.exports = { linkNewFile }
