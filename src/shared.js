// SPDX-License-Identifier: Apache-2.0
'use strict'
// SPDX-License-Identifier: Apache-2.0
// shared.js — Shared namespace write ops (shared-namespace). MEM-032/MEM-033 enforcement.
const fsP  = require('fs').promises
const path = require('path')
const p    = require('./paths')
const { buildFrontmatterV2, hashBody, readMemoryFile, invalidateMemory } = require('./schema_v2')
const { tokenize } = require('./write')
class SharedNamespaceAccessError extends Error {
  constructor(agentId) { super(`Shared write denied for agent: ${agentId}`); this.name = 'SharedNamespaceAccessError' }
}
class SharedConfidenceError extends Error {
  constructor(score, floor) { super(`Confidence ${score} below shared floor ${floor}`); this.name = 'SharedConfidenceError' }
}
// MEM-032: shared write authorization. mnemoDir optional (for denied access logging).
async function assertSharedWriteAccess(agentId, config, mnemoDir) {
  const writers = config.shared_namespace_writers ?? ['agent-orchestrator', 'agent-memory']
  if (writers.includes(agentId)) return
  if (mnemoDir) {
    const logPath = path.join(p.sharedMetaDir(mnemoDir), 'shared_access_log.jsonl')
    const entry = JSON.stringify({ ts: new Date().toISOString(), agentId, action: 'DENIED' }) + '\n'
    await fsP.appendFile(logPath, entry, 'utf8').catch(() => {})
  }
  throw new SharedNamespaceAccessError(agentId)
}
// MEM-033: shared confidence floor enforcement.
function assertSharedConfidence(confidenceScore, config) {
  const clampedFloor = Math.max(config.shared_l2_confidence_floor ?? 0.85, 0.85)
  if (confidenceScore < clampedFloor) throw new SharedConfidenceError(confidenceScore, clampedFloor)
}
// promoteToSharedL2 (AC-07/08/09/10)
async function promoteToSharedL2(factId, sourceAgentId, mnemoDir, config) {
  await assertSharedWriteAccess(sourceAgentId, config, mnemoDir)
  const sourceFact = await readMemoryFile(
    (await findFactFile(factId, mnemoDir, sourceAgentId)))
  assertSharedConfidence(sourceFact.frontMatter.confidence_score, config)
  // AC-09: check for existing active shared L2 with same subject
  const sharedL2Dir = path.join(p.sharedLayerDir(mnemoDir, 'L2'), 'topics')
  await fsP.mkdir(sharedL2Dir, { recursive: true })
  const existingFiles = await fsP.readdir(sharedL2Dir).catch(() => [])
  for (const f of existingFiles) {
    if (!f.endsWith('.md')) continue
    try {
      const existing = await readMemoryFile(path.join(sharedL2Dir, f))
      if (existing.frontMatter.status === 'active' &&
          existing.frontMatter.subject === sourceFact.frontMatter.subject) {
        await invalidateMemory(existing.filePath, new Date().toISOString())
      }
    } catch { /* skip malformed */ }
  }
  // Build shared copy
  const now = new Date().toISOString()
  const sharedId = `MEM-shared-${Date.now()}`
  const fm = {
    ...sourceFact.frontMatter, id: sharedId, namespace: 'shared',
    source_agent: sourceAgentId, promoted_at: now,
    created: now, valid_from: now, valid_until: null, status: 'active',
  }
  const body = sourceFact.body
  fm.content_hash = hashBody(body)
  const filePath = path.join(sharedL2Dir, `shared_${sharedId}.md`)
  // AC-10: fsync write sequence (ledger rule P4 N6)
  let fd
  try {
    fd = await fsP.open(filePath, 'wx')
    await fsP.writeFile(fd, buildFrontmatterV2(fm) + '\n' + body + '\n', 'utf8')
    await fsP.fsync(fd)
    await fsP.close(fd)
  } catch (err) {
    if (fd) await fsP.close(fd).catch(() => {})
    throw err
  }
  // Inline index updates (OQ-1: inline for L2) — uses shared/_meta/ paths, NOT _index/
  await Promise.all([
    updateSharedIndex(p.sharedInvertedIndexPath(mnemoDir), sharedId, fm.tags || [], body),
    updateSharedSalience(p.sharedSalienceMapPath(mnemoDir), sharedId, 1.0),
    updateSharedFileIndex(p.sharedFileIndexPath(mnemoDir), sharedId, filePath),
  ])
  // AC-10: log AFTER fsync
  const promotionLogPath = path.join(p.sharedMetaDir(mnemoDir), 'shared_promotion_log.jsonl')
  const logEntry = JSON.stringify({ ts: now, factId, sharedId, sourceAgentId }) + '\n'
  await fsP.appendFile(promotionLogPath, logEntry, 'utf8').catch(() => {})
  return { sharedId, filePath }
}
async function findFactFile(factId, mnemoDir, agentId) {
  const fileIndexPath = p.fileIndexPath(mnemoDir, agentId)
  try {
    const idx = JSON.parse(await fsP.readFile(fileIndexPath, 'utf8'))
    if (idx[factId]) return idx[factId]
  } catch { /* fall through */ }
  throw new Error(`Fact ${factId} not found in agent ${agentId} file index`)
}
// promoteToSharedL3 (AC-11/12/13)
async function promoteToSharedL3(procedureId, l3FilePath, agentId, mnemoDir, config) {
  await assertSharedWriteAccess(agentId, config, mnemoDir)
  if (config.shared_l3_promotion_enabled === false) return { status: 'disabled' }
  const sharedL3Dir = path.join(p.sharedLayerDir(mnemoDir, 'L3'))
  await fsP.mkdir(sharedL3Dir, { recursive: true })
  const targetPath = path.join(sharedL3Dir, `l3_${procedureId}.md`)
  // AC-13: idempotent — if file exists, skip
  try { await fsP.access(targetPath); return { status: 'already_elevated' } } catch { /* proceed */ }
  // Read source and build shared copy
  const source = await readMemoryFile(l3FilePath)
  const now = new Date().toISOString()
  const fm = {
    ...source.frontMatter, namespace: 'shared',
    promoted_from_agent: agentId, promoted_at: now,
  }
  // fsync write sequence
  let fd
  try {
    fd = await fsP.open(targetPath, 'wx')
    await fsP.writeFile(fd, buildFrontmatterV2(fm) + '\n' + source.body + '\n', 'utf8')
    await fsP.fsync(fd)
    await fsP.close(fd)
  } catch (err) {
    if (err.code === 'EEXIST') return { status: 'already_elevated' }
    if (fd) await fsP.close(fd).catch(() => {})
    throw err
  }
  return { status: 'written', filePath: targetPath }
}
// Shared index helpers (write to shared/_meta/, NOT _index/)
async function readJsonFile(p) { try { return JSON.parse(await fsP.readFile(p, 'utf8')) } catch { return {} } }
async function updateSharedIndex(idxPath, memId, tags, body) {
  const idx = await readJsonFile(idxPath)
  for (const t of tokenize([...tags, body].join(' '))) { if (!idx[t]) idx[t] = []; if (!idx[t].includes(memId)) idx[t].push(memId) }
  await fsP.writeFile(idxPath, JSON.stringify(idx), 'utf8')
}
async function updateSharedSalience(mapPath, memId, val) {
  const m = await readJsonFile(mapPath); m[memId] = val; await fsP.writeFile(mapPath, JSON.stringify(m), 'utf8')
}
async function updateSharedFileIndex(idxPath, memId, fp) {
  const m = await readJsonFile(idxPath); m[memId] = fp; await fsP.writeFile(idxPath, JSON.stringify(m), 'utf8')
}

module.exports = {
  assertSharedWriteAccess,
  assertSharedConfidence,
  promoteToSharedL2,
  promoteToSharedL3,
  SharedNamespaceAccessError,
  SharedConfidenceError,
}
