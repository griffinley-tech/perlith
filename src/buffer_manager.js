// SPDX-License-Identifier: Apache-2.0
'use strict'
// SPDX-License-Identifier: Apache-2.0

// buffer_manager.js — Dual-Buffer Toggle: atomic rotation, lock, dream cycle guard


const fs   = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// Buffer path resolution (AC-16 — no hardcoded paths)
// ---------------------------------------------------------------------------

// Resolve _meta directory from mnemoDir + agentId.
function resolveMetaDir(mnemoDir, agentId) {
  return path.join(mnemoDir, agentId, '_meta')
}

// Return the path to buffer_active directory.
function getActiveBufferPath(mnemoDir, agentId, config) {
  const metaDir    = resolveMetaDir(mnemoDir, agentId)
  const bufferName = (config && config.buffer_active_name) || 'buffer_active'
  return path.join(metaDir, bufferName)
}

// Return the path to buffer_processing directory.
function getProcessingBufferPath(mnemoDir, agentId, config) {
  const metaDir    = resolveMetaDir(mnemoDir, agentId)
  const bufferName = (config && config.buffer_processing_name) || 'buffer_processing'
  return path.join(metaDir, bufferName)
}

// Return the path to the dream lock file.
function getLockFilePath(mnemoDir, agentId, config) {
  const processingPath = getProcessingBufferPath(mnemoDir, agentId, config)
  const lockName       = (config && config.buffer_lock_name) || 'buffer_processing.lock'
  return path.join(processingPath, lockName)
}

// ---------------------------------------------------------------------------
// Write and read target resolution (AC-17 / AC-18)
// ---------------------------------------------------------------------------

// Always returns buffer_active path — the exclusive write target post-rotation.
function getWriteTarget(mnemoDir, agentId, config) {
  return getActiveBufferPath(mnemoDir, agentId, config)
}

// Returns [L2 dir, buffer_active path] — buffer_processing is NEVER in this list (AC-18).
function getReadTargets(mnemoDir, agentId, config) {
  const l2Dir     = path.join(mnemoDir, agentId, 'L2_semantic')
  const activeBuf = getActiveBufferPath(mnemoDir, agentId, config)
  return [l2Dir, activeBuf]
}

// ---------------------------------------------------------------------------
// Lock acquisition and release (§4.3)
// ---------------------------------------------------------------------------

// Write lock file with acquired_at + pid. Throws if already held by another live pid.
function acquireProcessingLock(mnemoDir, agentId, config) {
  const lockPath = getLockFilePath(mnemoDir, agentId, config)

  if (fs.existsSync(lockPath)) {
    return handleExistingLock(lockPath, mnemoDir, agentId, config)
  }

  writeLockFile(lockPath)
  return { acquired: true }
}

// Handle an existing lock file — check if prior pid is still alive.
function handleExistingLock(lockPath, mnemoDir, agentId, config) {
  const priorLock = readLockFile(lockPath)
  const priorPid  = priorLock && priorLock.pid

  if (priorPid && isPidAlive(priorPid)) {
    appendEscLogFromBufferManager(mnemoDir, agentId, {
      type:      'rotation_skipped',
      reason:    'prior_cycle_running',
      prior_pid: priorPid,
      ts:        Date.now(),
    })
    return { acquired: false, reason: 'prior_cycle_running', prior_pid: priorPid }
  }

  // Dead pid — stale lock. Clean up and proceed.
  recoverStaleLock(lockPath, mnemoDir, agentId, config, priorPid)
  writeLockFile(lockPath)
  return { acquired: true, recovered_stale: true, prior_pid: priorPid }
}

// Write lock file JSON.
function writeLockFile(lockPath) {
  const payload = JSON.stringify({ acquired_at: new Date().toISOString(), pid: process.pid })
  fs.writeFileSync(lockPath, payload, 'utf8')
}

// Read and parse lock file. Returns null on any read/parse failure.
function readLockFile(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch (_) {
    return null
  }
}

// Check if a pid is alive without sending a signal.
function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (_) {
    return false
  }
}

// Rename orphaned buffer_processing to buffer_processing_orphan_{date} for forensics.
function recoverStaleLock(lockPath, mnemoDir, agentId, config, priorPid) {
  fs.unlinkSync(lockPath)
  const processingPath = getProcessingBufferPath(mnemoDir, agentId, config)

  if (fs.existsSync(processingPath)) {
    const dateStr = new Date().toISOString().slice(0, 10)
    const orphanPath = processingPath + `_orphan_${dateStr}_pid${priorPid}`
    fs.renameSync(processingPath, orphanPath)
    appendEscLogFromBufferManager(mnemoDir, agentId, {
      type:        'orphan_processing_recovered',
      orphan_path: orphanPath,
      prior_pid:   priorPid,
      ts:          Date.now(),
    })
  }
}

// Delete lock file to release processing lock.
function releaseProcessingLock(mnemoDir, agentId, config) {
  const lockPath = getLockFilePath(mnemoDir, agentId, config)
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath)
  }
}

// Check if processing lock is currently held (guard against double-fire).
function isProcessingLockHeld(mnemoDir, agentId, config) {
  const lockPath = getLockFilePath(mnemoDir, agentId, config)
  if (!fs.existsSync(lockPath)) return false

  const lock = readLockFile(lockPath)
  if (!lock) return false
  return isPidAlive(lock.pid)
}

// ---------------------------------------------------------------------------
// Atomic buffer rotation (MEM-019 / AC-15 / AC-16)
// ---------------------------------------------------------------------------

// Rotate buffers: rename buffer_active → buffer_processing; create new buffer_active.
// Dispatches on config.buffer_rotation_backend (AC-16). Default: 'filesystem'.
function rotateBuffers(mnemoDir, agentId, config) {
  const backend = (config && config.buffer_rotation_backend) || 'filesystem'

  if (backend === 'filesystem') {
    return rotateFilesystem(mnemoDir, agentId, config)
  }

  // Future backends (e.g. 'redis') extend here without changing call sites.
  throw new Error(`Unknown buffer_rotation_backend: ${backend}`)
}

// Filesystem atomic rotation.
// Step 1: rename active → processing (atomic within same volume — OQ-5 confirmed below).
// Step 2: mkdir new buffer_active (sync, same tick).
// No interval exists between steps during which buffer_active is absent.
function rotateFilesystem(mnemoDir, agentId, config) {
  const activePath     = getActiveBufferPath(mnemoDir, agentId, config)
  const processingPath = getProcessingBufferPath(mnemoDir, agentId, config)

  ensureBufferExists(activePath)

  // Step 1 — rename (atomic on same NTFS volume — see OQ-5 note in HANDOFF)
  fs.renameSync(activePath, processingPath)

  // Step 2 — create fresh buffer_active immediately (MEM-019)
  fs.mkdirSync(activePath, { recursive: true })

  appendEscLogFromBufferManager(mnemoDir, agentId, {
    type:       'buffer_rotated',
    active:     activePath,
    processing: processingPath,
    pid:        process.pid,
    ts:         Date.now(),
  })

  return { active: activePath, processing: processingPath }
}

// Ensure buffer_active exists before rotation attempt.
function ensureBufferExists(activePath) {
  if (!fs.existsSync(activePath)) {
    fs.mkdirSync(activePath, { recursive: true })
  }
}

// ---------------------------------------------------------------------------
// ESC log helper (avoids circular dep — buffer_manager cannot import esc.js)
// ---------------------------------------------------------------------------

function appendEscLogFromBufferManager(mnemoDir, agentId, entry) {
  try {
    const metaDir = resolveMetaDir(mnemoDir, agentId)
    const logPath = path.join(metaDir, 'esc_log.jsonl')
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8')
  } catch (_) {
    // log write failure is non-fatal
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getActiveBufferPath,
  getProcessingBufferPath,
  getWriteTarget,
  getReadTargets,
  rotateBuffers,
  acquireProcessingLock,
  releaseProcessingLock,
  isProcessingLockHeld,
}
