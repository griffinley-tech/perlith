'use strict'
// SPDX-License-Identifier: Apache-2.0

const fs     = require('fs').promises
const path   = require('path')
const p      = require('./paths')
const schema = require('./schema')
const git    = require('./git')
const { generateId, loadConfig, loadManifest, saveManifest } = require('./init')

// Read a memory file and return {frontMatter, body, filePath}
async function readMemory(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const { frontMatter, body } = schema.parse(raw)
  return { frontMatter, body, filePath }
}

// Write a memory file. Validates schema before writing. Returns filePath.
async function writeMemory(filePath, frontMatter, body) {
  schema.validate(frontMatter, body, frontMatter.layer)
  const content = schema.serialize(frontMatter, body)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf8')
  return filePath
}

// Add a new memory. Handles L0 cap, ID generation, index update, git commit.
// Pass noCommit: true to skip git (useful for bulk seeding and benchmarks).
async function addMemory(baseDir, agentId, { layer, type, body, tags = [], subtopic, sourceEpisode = null, noCommit = false }) {
  const config = await loadConfig(baseDir, agentId)
  const root   = p.agentRoot(baseDir, agentId)

  // Enforce working memory cap before writing
  if (layer === 'L0') {
    await enforceWorkingCap(baseDir, agentId, config, root)
  }

  const id = await generateId(baseDir, agentId)
  const frontMatter = schema.buildFrontMatter(id, type || layerToType(layer), layer, tags, sourceEpisode)
  const filePath = p.memoryFilePath(baseDir, agentId, id, layer, subtopic)

  await writeMemory(filePath, frontMatter, body)
  await updateInvertedIndex(baseDir, agentId, id, tags, body)
  await updateSalienceMap(baseDir, agentId, id, 1.0)
  await updateFileIndex(baseDir, agentId, id, filePath)

  if (!noCommit) {
    await git.gitCommit(root, `perlith: add ${layer} ${id}`, [filePath])
  }

  return { id, filePath, frontMatter }
}

// Update front-matter fields of an existing memory file in place
async function patchMemory(filePath, patches) {
  const { frontMatter, body } = await readMemory(filePath)
  const updated = { ...frontMatter, ...patches }
  schema.validate(updated, body, updated.layer)
  await fs.writeFile(filePath, schema.serialize(updated, body), 'utf8')
  return updated
}

// Move a memory file to _archive/. Does not delete. Commits to git.
async function archiveMemory(baseDir, agentId, filePath, memoryId, salience) {
  const root = p.agentRoot(baseDir, agentId)
  const dest = p.archivePath(baseDir, agentId, memoryId)
  await patchMemory(filePath, { status: 'archived' })
  await fs.rename(filePath, dest)
  await git.gitCommit(root,
    `perlith: archive ${memoryId} salience=${salience.toFixed(4)}`, ['.'])
}

// Mark an existing memory as superseded and create a new one replacing it
async function supersedeMemory(baseDir, agentId, oldFilePath, newFact, sourceEpisode) {
  const root    = p.agentRoot(baseDir, agentId)
  const config  = await loadConfig(baseDir, agentId)
  const newId   = await generateId(baseDir, agentId)
  const { frontMatter: oldMeta } = await readMemory(oldFilePath)

  // Determine subtopic from old file path
  const subtopic = inferSubtopic(oldFilePath)
  const newFM   = schema.buildFrontMatter(newId, 'semantic', 'L2', newFact.tags || oldMeta.tags, sourceEpisode)
  const newPath = p.memoryFilePath(baseDir, agentId, newId, 'L2', subtopic)

  await writeMemory(newPath, newFM, newFact.sentence)
  await patchMemory(oldFilePath, { status: 'superseded', superseded_by: newId })
  await updateInvertedIndex(baseDir, agentId, newId, newFM.tags, newFact.sentence)
  await updateSalienceMap(baseDir, agentId, newId, 1.0)

  await git.gitCommit(root, `perlith: supersede ${oldMeta.id} -> ${newId}`, ['.'])
  return { newId, newPath }
}

// Enumerate all active (non-archived, non-superseded) memory files for an agent
async function listActiveFiles(baseDir, agentId, layers = ['L0','L1','L2','L3','L4']) {
  const results = []
  const root = p.agentRoot(baseDir, agentId)

  async function walk(dir) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) }
    catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { await walk(full) }
      else if (e.name.endsWith('.md')) {
        try {
          const { frontMatter } = await readMemory(full)
          if (frontMatter.status === 'active' && layers.includes(frontMatter.layer)) {
            results.push({ filePath: full, frontMatter })
          }
        } catch { /* skip malformed files */ }
      }
    }
  }

  for (const layer of layers) {
    const layerPath = p.layerDir(baseDir, agentId, layer)
    await walk(layerPath)
  }

  return results
}

// --- Index helpers ---

async function updateInvertedIndex(baseDir, agentId, memoryId, tags, body) {
  const indexPath = p.invertedIndexPath(baseDir, agentId)
  let index = {}
  try { index = JSON.parse(await fs.readFile(indexPath, 'utf8')) } catch {}

  const tokens = tokenize([...tags, body].join(' '))
  for (const token of tokens) {
    if (!index[token]) index[token] = []
    if (!index[token].includes(memoryId)) index[token].push(memoryId)
  }

  await fs.writeFile(indexPath, JSON.stringify(index), 'utf8')
}

async function updateFileIndex(baseDir, agentId, memoryId, filePath) {
  const indexPath = p.fileIndexPath(baseDir, agentId)
  let index = {}
  try { index = JSON.parse(await fs.readFile(indexPath, 'utf8')) } catch {}
  index[memoryId] = filePath
  await fs.writeFile(indexPath, JSON.stringify(index), 'utf8')
}

async function updateSalienceMap(baseDir, agentId, memoryId, salience) {
  const mapPath = p.salienceMapPath(baseDir, agentId)
  let map = {}
  try { map = JSON.parse(await fs.readFile(mapPath, 'utf8')) } catch {}
  map[memoryId] = salience
  await fs.writeFile(mapPath, JSON.stringify(map), 'utf8')
}

// --- Internal helpers ---

async function enforceWorkingCap(baseDir, agentId, config, root) {
  const slots = await listActiveFiles(baseDir, agentId, ['L0'])
  if (slots.length < config.working_memory_cap) return

  // Demote lowest-salience slot to L1
  slots.sort((a, b) => a.frontMatter.salience - b.frontMatter.salience)
  const victim = slots[0]
  const newId = await generateId(baseDir, agentId)
  const newPath = p.memoryFilePath(baseDir, agentId, newId, 'L1')

  await fs.mkdir(path.dirname(newPath), { recursive: true })
  await patchMemory(victim.filePath, { layer: 'L1', type: 'episodic',
    decay_rate: 0.04, status: 'active' })
  await fs.rename(victim.filePath, newPath)
  await git.gitCommit(root, `perlith: demote ${victim.frontMatter.id} L0->L1`, ['.'])
}

function layerToType(layer) {
  const map = { L0: 'working', L1: 'episodic', L2: 'semantic', L3: 'procedural', L4: 'prospective' }
  return map[layer] || 'episodic'
}

function inferSubtopic(filePath) {
  if (filePath.includes('entities')) return 'entities'
  if (filePath.includes('patterns')) return 'patterns'
  return 'topics'
}

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2)
}

module.exports = {
  readMemory,
  writeMemory,
  addMemory,
  patchMemory,
  archiveMemory,
  supersedeMemory,
  listActiveFiles,
  updateInvertedIndex,
  updateSalienceMap,
  updateFileIndex,
  tokenize,
}
