// SPDX-License-Identifier: Apache-2.0
'use strict'
// SPDX-License-Identifier: Apache-2.0

const path = require('path')

const LAYER_DIRS = {
  L0: 'L0_working',
  L1: 'L1_episodic',
  L2: 'L2_semantic',
  L3: 'L3_procedural',
  L4: 'L4_prospective',
}

const L2_SUBDIRS = ['entities', 'topics', 'patterns']

function agentRoot(baseDir, agentId) {
  return path.join(baseDir, agentId)
}

function layerDir(baseDir, agentId, layer) {
  if (!LAYER_DIRS[layer]) throw new Error(`Unknown layer: ${layer}`)
  return path.join(agentRoot(baseDir, agentId), LAYER_DIRS[layer])
}

function episodicDir(baseDir, agentId, date) {
  // date: Date object or ISO string
  const d = new Date(date)
  const yyyy = d.getUTCFullYear()
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd   = String(d.getUTCDate()).padStart(2, '0')
  return path.join(layerDir(baseDir, agentId, 'L1'), String(yyyy), mm, dd)
}

function semanticSubdir(baseDir, agentId, subtopic) {
  if (!L2_SUBDIRS.includes(subtopic)) throw new Error(`Unknown L2 subtopic: ${subtopic}`)
  return path.join(layerDir(baseDir, agentId, 'L2'), subtopic)
}

function indexDir(baseDir, agentId) { return path.join(agentRoot(baseDir, agentId), '_index') }
function archiveDir(baseDir, agentId) { return path.join(agentRoot(baseDir, agentId), '_archive') }
function metaDir(baseDir, agentId) { return path.join(agentRoot(baseDir, agentId), '_meta') }
function manifestPath(baseDir, agentId) { return path.join(indexDir(baseDir, agentId), 'manifest.json') }
function invertedIndexPath(baseDir, agentId) { return path.join(indexDir(baseDir, agentId), 'inverted_index.json') }
function salienceMapPath(baseDir, agentId) { return path.join(indexDir(baseDir, agentId), 'salience_map.json') }
function configPath(baseDir, agentId) { return path.join(metaDir(baseDir, agentId), 'config.yaml') }
function fileIndexPath(baseDir, agentId) { return path.join(indexDir(baseDir, agentId), 'file_index.json') }
function gardenerLogPath(baseDir, agentId) { return path.join(metaDir(baseDir, agentId), 'gardener_log.md') }

function memoryFilePath(baseDir, agentId, memoryId, layer, subtopic) {
  if (layer === 'L0') return path.join(layerDir(baseDir, agentId, 'L0'), `${memoryId}.md`)
  if (layer === 'L1') return path.join(episodicDir(baseDir, agentId, new Date()), `${memoryId}.md`)
  if (layer === 'L2') return path.join(semanticSubdir(baseDir, agentId, subtopic || 'topics'), `${memoryId}.md`)
  if (layer === 'L3') return path.join(layerDir(baseDir, agentId, 'L3'), `${memoryId}.md`)
  if (layer === 'L4') return path.join(layerDir(baseDir, agentId, 'L4'), `${memoryId}.md`)
  throw new Error(`Unknown layer: ${layer}`)
}

function archivePath(baseDir, agentId, memoryId) { return path.join(archiveDir(baseDir, agentId), `${memoryId}.md`) }
function edgeAuditLogPath(baseDir, agentId) { return path.join(metaDir(baseDir, agentId), 'edge_audit_log.jsonl') }
function edgeErrorLogPath(baseDir, agentId) { return path.join(metaDir(baseDir, agentId), 'edge_error_log.jsonl') }

// --- Shared namespace path helpers (shared-namespace, AC-01/AC-02) ---
function sharedRoot(baseDir) { return path.join(baseDir, 'shared') }
function sharedLayerDir(baseDir, layer) {
  if (layer !== 'L2' && layer !== 'L3') throw new Error('Shared namespace supports L2/L3 only')
  return path.join(sharedRoot(baseDir), LAYER_DIRS[layer])
}
function sharedMetaDir(baseDir) { return path.join(sharedRoot(baseDir), '_meta') }
function sharedIndexDir(baseDir) { return sharedMetaDir(baseDir) }
function sharedFileIndexPath(baseDir) { return path.join(sharedMetaDir(baseDir), 'file_index.json') }
function sharedInvertedIndexPath(baseDir) { return path.join(sharedMetaDir(baseDir), 'inverted_index.json') }
function sharedSalienceMapPath(baseDir) { return path.join(sharedMetaDir(baseDir), 'salience_map.json') }

module.exports = {
  agentRoot,
  layerDir,
  episodicDir,
  semanticSubdir,
  indexDir,
  archiveDir,
  metaDir,
  manifestPath,
  invertedIndexPath,
  salienceMapPath,
  fileIndexPath,
  configPath,
  gardenerLogPath,
  memoryFilePath,
  archivePath,
  edgeAuditLogPath,
  edgeErrorLogPath,
  sharedRoot,
  sharedLayerDir,
  sharedMetaDir,
  sharedIndexDir,
  sharedFileIndexPath,
  sharedInvertedIndexPath,
  sharedSalienceMapPath,
  LAYER_DIRS,
  L2_SUBDIRS,
}
