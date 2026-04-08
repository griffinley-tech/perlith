'use strict'
// SPDX-License-Identifier: Apache-2.0

// activation_lifecycle.js — Three-phase activation lifecycle
// Three-phase activation lifecycle: PRE-FLIGHT → TASK → POST-TASK.
// Sync write is in-process. No try/catch inside writeL1Sync.
// All config-driven — no hardcoded agent names, paths, or thresholds.

const fs    = require('fs')
const fsP   = require('fs').promises
const path  = require('path')
const { EventEmitter } = require('events')
const { validateL1Record } = require('./activation_schema')
const { loadConfig } = require('./init')
const p = require('./paths')

// Module-level emitter — callers subscribe to lifecycle events.
const lifecycle = new EventEmitter()

// Load activation config from the global _meta/ directory.
async function loadActivationConfig(metaDir) {
  const raw = await fsP.readFile(path.join(metaDir, 'activation_config.json'), 'utf8')
  const config = JSON.parse(raw)
  validateSharedNamespaceConfig(config)
  return config
}

// Startup validation for shared namespace config keys.
function validateSharedNamespaceConfig(config) {
  if (Array.isArray(config.shared_namespace_writers) && config.shared_namespace_writers.length === 0) {
    throw new Error('FATAL: shared_namespace_writers is empty — no agent can write to shared namespace')
  }
  if (config.shared_namespace_writers === undefined) {
    config.shared_namespace_writers = ['agent-orchestrator', 'agent-memory']
  }
  if (config.shared_l2_confidence_floor !== undefined && config.shared_l2_confidence_floor < 0.85) {
    console.warn(`[config] shared_l2_confidence_floor=${config.shared_l2_confidence_floor} < 0.85; clamped`)
    config.shared_l2_confidence_floor = 0.85
  }
  if (config.shared_l3_min_sessions !== undefined && config.shared_l3_min_sessions < 3) {
    console.warn(`[config] shared_l3_min_sessions=${config.shared_l3_min_sessions} < 3; clamped`)
    config.shared_l3_min_sessions = 3
  }
}

// Allocate an L0 working-memory slot for the agent.
// If all slots are occupied, evict the oldest by created timestamp.
async function allocateL0Slot(baseDir, agentId, perlith, activationConfig) {
  const agentConfig = await loadConfig(baseDir, agentId)
  const cap = agentConfig.working_memory_cap || 7
  const slots = await perlith.listActiveFiles(baseDir, agentId, ['L0'])

  if (slots.length >= cap) {
    slots.sort((a, b) =>
      new Date(a.frontMatter.created) - new Date(b.frontMatter.created)
    )
    await fsP.unlink(slots[0].filePath)
  }

  return await perlith.addMemory(baseDir, agentId, {
    layer: 'L0', type: 'working', body: 'activation-slot',
    tags: ['activation-slot'], noCommit: true,
  })
}

async function clearL0Slot(slotFilePath) {
  await fsP.unlink(slotFilePath)
}

// Query L0, L2, and last-3 L1 entries for agent_id.
async function queryMemoryLayers(baseDir, agentId, query, perlith) {
  const agentConfig = await loadConfig(baseDir, agentId)

  const [l0Files, l2Results, l1Files] = await Promise.all([
    perlith.listActiveFiles(baseDir, agentId, ['L0']),
    perlith.retrieve(baseDir, agentId, query, agentConfig).catch(() => []),
    perlith.listActiveFiles(baseDir, agentId, ['L1']),
  ])

  const lastThreeL1 = l1Files
    .sort((a, b) => new Date(b.frontMatter.created) - new Date(a.frontMatter.created))
    .slice(0, 3)

  return { l0: l0Files, l2: l2Results, l1: lastThreeL1 }
}

// PRE-FLIGHT phase — returns { slot, memoryContext, activationConfig, preflightMs, escHit }.
async function preFlight(baseDir, agentId, query, taskId, perlith, metaDir) {
  const preflightStart   = Date.now()
  const activationConfig = await loadActivationConfig(metaDir)

  const slot = await allocateL0Slot(baseDir, agentId, perlith, activationConfig)
  const memoryContext = await queryMemoryLayers(baseDir, agentId, query, perlith)
  const escHit = memoryContext.l2.length > 0

  return {
    slot, memoryContext, activationConfig,
    preflightMs: Date.now() - preflightStart, escHit,
  }
}

// Sync write of an L1 episodic record. fsync'd for durability.
// No try/catch — error propagates to caller.
function writeL1Sync(record, config, baseDir, agentId) {
  validateL1Record(record, config)

  const now     = new Date()
  const yyyy    = now.getUTCFullYear()
  const mm      = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd      = String(now.getUTCDate()).padStart(2, '0')
  const episDir = path.join(p.layerDir(baseDir, agentId, 'L1'), String(yyyy), mm, dd)

  fs.mkdirSync(episDir, { recursive: true })

  const filePath = path.join(episDir, `${record.task_id}.md`)
  const content  = serializeL1Record(record)

  const fd = fs.openSync(filePath, 'wx')
  fs.writeSync(fd, content)
  fs.fsyncSync(fd)
  fs.closeSync(fd)

  return filePath
}

function serializeL1Record(record) {
  const yaml = require('js-yaml')
  const fm   = record.frontMatter || {}
  return [
    '---',
    yaml.dump({
      ...fm,
      activation_source: record.activation_source,
      task_id:           record.task_id,
      rules_triggered:   record.rules_triggered,
      outcome:           record.outcome,
    }, { lineWidth: 120 }).trimEnd(),
    '---',
    '',
    JSON.stringify({ inputs: record.inputs, outputs: record.outputs }, null, 2),
    '',
  ].join('\n')
}

function appendTelemetry(metaDir, record) {
  try {
    const logPath = path.join(metaDir, 'telemetry_log.jsonl')
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8')
  } catch (_) {}
}

// POST-TASK phase — validates, writes, clears L0 slot, appends telemetry.
async function postTask(record, preFlightResult, baseDir, agentId, metaDir) {
  const { slot, activationConfig, preflightMs, escHit } = preFlightResult

  const writePromise = new Promise((resolve, reject) => {
    try { resolve(writeL1Sync(record, activationConfig, baseDir, agentId)) }
    catch (err) { reject(err) }
  })

  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`writeL1Sync timed out after ${activationConfig.sync_write_timeout_ms}ms`)),
      activationConfig.sync_write_timeout_ms
    )
  )

  const filePath = await Promise.race([writePromise, timeout])
  await clearL0Slot(slot.filePath)

  appendTelemetry(metaDir, {
    timestamp:    new Date().toISOString(),
    agent_id:     agentId,
    task_id:      record.task_id,
    preflight_ms: preflightMs ?? null,
    esc_hit:      escHit ?? null,
    l1_written:   true,
  })

  return { filePath }
}

module.exports = {
  preFlight,
  postTask,
  writeL1Sync,
  loadActivationConfig,
  lifecycle,
}
