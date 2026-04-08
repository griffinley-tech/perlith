'use strict'
// SPDX-License-Identifier: Apache-2.0

// Perlith — Agent Memory OS
// Public API surface for the OSS skeleton.
// File-based, Git-native, zero database.

const { initAgent, loadConfig, loadManifest, generateId, DEFAULT_CONFIG } = require('./init')
const { addMemory, readMemory, writeMemory, patchMemory, archiveMemory,
        supersedeMemory, listActiveFiles } = require('./write')
const { retrieve } = require('./retrieve')
const { preFlight, postTask, writeL1Sync, loadActivationConfig, lifecycle } = require('./activation_lifecycle')
const { validateL1Record, VALID_OUTCOMES } = require('./activation_schema')
const { canonicalizeBody, hashBody, readMemoryFile, verifyHash,
        buildFrontmatterV2 } = require('./schema_v2')
const { createEdgePair, attachPredecessorEdge, validateEdgePair } = require('./temporal_edges')
const { promoteToSharedL2, promoteToSharedL3, assertSharedWriteAccess } = require('./shared')
const { detectConflicts } = require('./conflict')
const { runDecay, recencyScore } = require('./decay')
const { runAgent, consolidateSession, querySharedKnowledge } = require('./agent_runtime')
const { linkNewFile } = require('./linker')
const { rotateBuffers, acquireProcessingLock, releaseProcessingLock } = require('./buffer_manager')
const paths = require('./paths')

module.exports = {
  // Agent lifecycle
  initAgent,
  loadConfig,
  loadManifest,
  generateId,
  DEFAULT_CONFIG,

  // Memory operations (CRUD)
  addMemory,
  readMemory,
  writeMemory,
  patchMemory,
  archiveMemory,
  supersedeMemory,
  listActiveFiles,

  // Retrieval
  retrieve,
  recencyScore,
  detectConflicts,

  // Activation contract
  preFlight,
  postTask,
  writeL1Sync,
  loadActivationConfig,
  validateL1Record,
  VALID_OUTCOMES,
  lifecycle,

  // Schema
  canonicalizeBody,
  hashBody,
  readMemoryFile,
  verifyHash,
  buildFrontmatterV2,

  // Temporal edges
  createEdgePair,
  attachPredecessorEdge,
  validateEdgePair,

  // Shared namespaces
  promoteToSharedL2,
  promoteToSharedL3,
  assertSharedWriteAccess,

  // Decay
  runDecay,

  // Agent runtime
  runAgent,
  consolidateSession,
  querySharedKnowledge,

  // Linking
  linkNewFile,

  // Buffer management
  rotateBuffers,
  acquireProcessingLock,
  releaseProcessingLock,

  // Paths (for custom integrations)
  paths,
}
