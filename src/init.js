// SPDX-License-Identifier: Apache-2.0
'use strict'
// SPDX-License-Identifier: Apache-2.0

const fs   = require('fs').promises
const path = require('path')
const yaml = require('js-yaml')
const p    = require('./paths')
const git  = require('./git')

const DEFAULT_CONFIG = {
  working_memory_cap:       7,
  archive_threshold:        0.15,
  reinforcement_delta:      0.10,
  consolidation_l1_trigger: 50,
  gardener_schedule:        '0 2 * * *',
  linker_min_shared_tags:   2,
  linker_max_links:         5,
  retrieval_max_results:    7,
  retrieval_overlap_cutoff:            0.85,
  retrieval_overlap_cutoff_factual:    0.5,
  retrieval_overlap_cutoff_aggregation: 0,
  retrieval_overlap_cutoff_context:    0.3,
  retrieve_edge_depth:      1,
  recency_halflife_days:    7,
  llm_model:                'claude-sonnet-4-6',
}

async function mkdirSafe(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

// Initialize all directories for an agent. Idempotent.
async function initAgent(baseDir, agentId) {
  const root = p.agentRoot(baseDir, agentId)

  const dirs = [
    p.layerDir(baseDir, agentId, 'L0'),
    p.layerDir(baseDir, agentId, 'L1'),
    p.layerDir(baseDir, agentId, 'L2'),
    p.semanticSubdir(baseDir, agentId, 'entities'),
    p.semanticSubdir(baseDir, agentId, 'topics'),
    p.semanticSubdir(baseDir, agentId, 'patterns'),
    p.layerDir(baseDir, agentId, 'L3'),
    p.layerDir(baseDir, agentId, 'L4'),
    p.indexDir(baseDir, agentId),
    p.archiveDir(baseDir, agentId),
    p.metaDir(baseDir, agentId),
  ]

  for (const dir of dirs) {
    await mkdirSafe(dir)
  }

  // Write config if not already present
  const configFile = p.configPath(baseDir, agentId)
  try {
    await fs.access(configFile)
  } catch {
    const config = { agent_id: agentId, ...DEFAULT_CONFIG }
    await fs.writeFile(configFile, yaml.dump(config), 'utf8')
  }

  // Write manifest if not already present
  const manifestFile = p.manifestPath(baseDir, agentId)
  try {
    await fs.access(manifestFile)
  } catch {
    const manifest = {
      agent_id:           agentId,
      last_consolidation: null,
      file_count:         0,
      daily_seq:          {},
    }
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), 'utf8')
  }

  // Write empty index files if not already present
  const invertedFile = p.invertedIndexPath(baseDir, agentId)
  try { await fs.access(invertedFile) } catch {
    await fs.writeFile(invertedFile, JSON.stringify({}), 'utf8')
  }

  const salienceFile = p.salienceMapPath(baseDir, agentId)
  try { await fs.access(salienceFile) } catch {
    await fs.writeFile(salienceFile, JSON.stringify({}), 'utf8')
  }

  const fileIndexFile = p.fileIndexPath(baseDir, agentId)
  try { await fs.access(fileIndexFile) } catch {
    await fs.writeFile(fileIndexFile, JSON.stringify({}), 'utf8')
  }

  // Initialize gardener log
  const logFile = p.gardenerLogPath(baseDir, agentId)
  try { await fs.access(logFile) } catch {
    await fs.writeFile(logFile,
      `# Gardener Log — ${agentId}\n\n`, 'utf8')
  }

  // Git init + initial commit
  await git.gitInit(root)
  await git.gitCommit(root, `perlith: init ${agentId}`)

  return root
}

// Load config.yaml for an agent. Returns parsed object.
async function loadConfig(baseDir, agentId) {
  const raw = await fs.readFile(p.configPath(baseDir, agentId), 'utf8')
  const config = yaml.load(raw)
  
  // Existing config.yaml files lack retrieve_edge_depth — default to 1 (depth-1 traversal).
  config.retrieve_edge_depth ??= 1
  return config
}

// Load manifest.json for an agent. Returns parsed object.
async function loadManifest(baseDir, agentId) {
  const raw = await fs.readFile(p.manifestPath(baseDir, agentId), 'utf8')
  return JSON.parse(raw)
}

// Write manifest back to disk (atomic via temp file pattern)
async function saveManifest(baseDir, agentId, manifest) {
  await fs.writeFile(p.manifestPath(baseDir, agentId),
    JSON.stringify(manifest, null, 2), 'utf8')
}

// Generate a new memory ID for an agent. Atomically increments daily sequence.
async function generateId(baseDir, agentId) {
  const manifest = await loadManifest(baseDir, agentId)
  const today = new Date()
  const key = today.toISOString().slice(0, 10).replace(/-/g, '')
  const seq = (manifest.daily_seq[key] || 0) + 1
  manifest.daily_seq[key] = seq
  manifest.file_count = (manifest.file_count || 0) + 1
  await saveManifest(baseDir, agentId, manifest)
  const safeAgent = agentId.slice(0, 8).replace(/[^a-z0-9]/g, '-')
  return `MEM-${key}-${safeAgent}-${String(seq).padStart(4, '0')}`
}

module.exports = {
  initAgent,
  loadConfig,
  loadManifest,
  saveManifest,
  generateId,
  DEFAULT_CONFIG,
}
