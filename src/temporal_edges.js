// SPDX-License-Identifier: Apache-2.0
'use strict'
// SPDX-License-Identifier: Apache-2.0

// temporal_edges.js — Temporal edge creation, audit logging, and validation

// MEM-029 (Edge Atomicity), MEM-030 (Edge Bidirectionality), MEM-031 (Edge Immutability)

const fs  = require('fs')
const fsP = require('fs').promises
const p   = require('./paths')
const { readMemoryFile, buildFrontmatterV2, invalidateMemory, supersedeMemory } = require('./schema_v2')
const { updateFileIndex } = require('./write')

// ---------------------------------------------------------------------------
// Edge creation — AC-01, AC-02, AC-04
// ---------------------------------------------------------------------------

// Create the superseded_by_edge on the predecessor file. Returns the edge object.
// For terminal invalidation (no successor), successorId is null (AC-04).
// type: 'INVALIDATE' or 'UPDATE'
// Uses invalidateMemory (INVALIDATE) or supersedeMemory (UPDATE) to write
// edge + status + valid_until atomically in one writeFile (OQ-2).
async function createEdgePair(predecessorFile, successorId, reason, cycleId, type, config, schema) {
  const now = new Date().toISOString()
  const edgeFields = {
    successor_id: successorId,
    edge_created_at: now,
    reason: reason || '',
    cycle_id: cycleId,
    supersession_type: type,
  }
  if (type === 'UPDATE') {
    await supersedeMemory(predecessorFile, now, edgeFields)
  } else {
    await invalidateMemory(predecessorFile, now, edgeFields)
  }
  return edgeFields
}

// ---------------------------------------------------------------------------
// Predecessor edge on successor — AC-03
// ---------------------------------------------------------------------------

// Attach predecessor_edge to the successor file's frontmatter.
// Reads, merges, rewrites in one writeFile call.
async function attachPredecessorEdge(successorFilePath, predecessorId, cycleId, type, schema) {
  const rec = await readMemoryFile(successorFilePath)
  const fm = { ...rec.frontMatter }
  fm.predecessor_edge = {
    predecessor_id: predecessorId,
    edge_created_at: new Date().toISOString(),
    supersession_type: type,
  }
  const updated = buildFrontmatterV2(fm) + '\n' + rec.body + '\n'
  await fsP.writeFile(successorFilePath, updated, 'utf8')
}

// ---------------------------------------------------------------------------
// Audit logging — AC-09, AC-10 (appendFile only, never truncate/overwrite)
// ---------------------------------------------------------------------------

// Append a JSONL entry to edge_audit_log.jsonl. Uses appendFile exclusively.
async function appendEdgeAuditLog(agentRoot, entry) {
  const logPath = p.edgeAuditLogPath(agentRoot, entry.agent_id)
  const line = JSON.stringify(entry) + '\n'
  await fsP.appendFile(logPath, line, 'utf8')
}

// ---------------------------------------------------------------------------
// Error logging — AC-05
// ---------------------------------------------------------------------------

// Append edge error entry to _meta/edge_error_log.jsonl.
async function logEdgeError(baseDir, agentId, entry) {
  const logPath = p.edgeErrorLogPath(baseDir, agentId)
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n'
  await fsP.appendFile(logPath, line, 'utf8')
}

// ---------------------------------------------------------------------------
// Edge validation — MEM-029, MEM-030
// ---------------------------------------------------------------------------

// Validate a single edge pair: check successor exists (MEM-029) and
// bidirectional match (MEM-030). Returns { valid, violations[] }.
async function validateEdgePair(predecessorFile, successorFile) {
  const violations = []
  let predRec, succRec
  try { predRec = await readMemoryFile(predecessorFile) } catch {
    return { valid: false, violations: [{ type: 'MEM-029', detail: 'predecessor file unreadable' }] }
  }
  const edge = predRec.frontMatter.superseded_by_edge
  if (!edge) return { valid: true, violations: [] }
  if (edge.successor_id === null) return { valid: true, violations: [] }

  if (!successorFile) {
    violations.push({ type: 'MEM-029', detail: `successor ${edge.successor_id} file not found` })
    return { valid: false, violations }
  }
  try { succRec = await readMemoryFile(successorFile) } catch {
    violations.push({ type: 'MEM-029', detail: `successor file unreadable: ${successorFile}` })
    return { valid: false, violations }
  }
  const predEdge = succRec.frontMatter.predecessor_edge
  if (!predEdge || predEdge.predecessor_id !== predRec.frontMatter.id) {
    violations.push({
      type: 'MEM-030',
      detail: `bidirectional mismatch: pred=${predRec.frontMatter.id}, succ predecessor_edge=${predEdge?.predecessor_id}`,
    })
  }
  return { valid: violations.length === 0, violations }
}

// ---------------------------------------------------------------------------
// Post-REM batch validation — runs after all edges created in a cycle
// ---------------------------------------------------------------------------

// Batch-validate all edge pairs from a REM cycle. Logs violations to error log.
async function runPostRemEdgeValidation(mnemoDir, agentId, edgePairs) {
  const violations = []
  for (const pair of edgePairs) {
    const result = await validateEdgePair(pair.predecessorFile, pair.successorFile)
    if (!result.valid) {
      for (const v of result.violations) {
        violations.push({ ...v, predecessor: pair.predecessorFile, successor: pair.successorFile })
        await logEdgeError(mnemoDir, agentId, {
          predecessor_id: pair.predecessorId,
          successor_id: pair.successorId,
          error: `${v.type}: ${v.detail}`,
          operation: pair.operation || 'VALIDATION',
        })
      }
    }
  }
  return { violations }
}

// ---------------------------------------------------------------------------
// UPDATE snapshot — extracted from rem_pipeline.js per R1 budget (TECH S4.3)
// ---------------------------------------------------------------------------

// Create a snapshot of the pre-update state as a new L2 file with status='SUPERSEDED'.
// The snapshot gets a NEW ID; the updated file keeps its ORIGINAL ID (TECH S5).
// Returns { snapshotId, snapshotPath }.
async function createUpdateSnapshot(existingRec, successorId, reason, cycleId, generateId, mnemoDir, agentId, schema, paths) {
  const now = new Date().toISOString()
  const snapshotId = await generateId(mnemoDir, agentId)
  const snapshotFm = { ...existingRec.frontMatter, id: snapshotId, valid_until: now, status: 'SUPERSEDED' }
  snapshotFm.superseded_by_edge = {
    successor_id: successorId,
    edge_created_at: now,
    reason: reason || '',
    cycle_id: cycleId,
    supersession_type: 'UPDATE',
  }
  const snapshotPath = paths.memoryFilePath(mnemoDir, agentId, snapshotId, 'L2', 'topics')
  const fsP2 = require('fs').promises
  const path2 = require('path')
  await fsP2.mkdir(path2.dirname(snapshotPath), { recursive: true })
  await fsP2.writeFile(snapshotPath, schema.buildFrontmatterV2(snapshotFm) + '\n' + existingRec.body + '\n', 'utf8')
  await updateFileIndex(mnemoDir, agentId, snapshotId, snapshotPath)
  return { snapshotId, snapshotPath }
}

module.exports = {
  createEdgePair,
  attachPredecessorEdge,
  appendEdgeAuditLog,
  logEdgeError,
  validateEdgePair,
  runPostRemEdgeValidation,
  createUpdateSnapshot,
}
