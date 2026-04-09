// SPDX-License-Identifier: Apache-2.0
'use strict'
// SPDX-License-Identifier: Apache-2.0

// agent_runtime.js — Universal Agent Memory Contract Middleware


const crypto     = require('crypto')
const path       = require('path')
const fsPromises = require('fs').promises
const Anthropic  = require('@anthropic-ai/sdk')

const { writeL1Sync, loadActivationConfig } = require('./activation_lifecycle')
const { retrieve }                           = require('./retrieve')

const anthropic = new Anthropic()

// ---------------------------------------------------------------------------
// validateRuntimeConfig
// Throws a named error if any required runtime key is absent from config.
// AC-9: absence = named error, not silent default.
// ---------------------------------------------------------------------------
function validateRuntimeConfig(config) {
  const REQUIRED_KEYS = [
    'runtime_consolidation_model',
    'runtime_session_ttl_seconds',
    'runtime_redis_buffer_prefix',
  ]
  for (const key of REQUIRED_KEYS) {
    if (config[key] === undefined) {
      throw new Error(`RUNTIME_CONFIG_ERROR: missing key: ${key}`)
    }
  }
}

// ---------------------------------------------------------------------------
// logRuntimeError
// Append-only structured error log. Never throws. AC-7.
// Signature per TECH §3.5: (agentId, sessionId, errorMessage, taskId, config)
// ---------------------------------------------------------------------------
async function logRuntimeError(agentId, sessionId, errorMessage, taskId, config) {
  try {
    const entry = {
      timestamp:     new Date().toISOString(),
      agentId,
      sessionId,
      error_message: errorMessage,
      task_id:       taskId,
    }
    const line    = JSON.stringify(entry) + '\n'
    const logPath = path.join(config.mnemoDir, '_meta', 'runtime_error_log.jsonl')
    await fsPromises.appendFile(logPath, line, 'utf8')
  } catch (err) {
    console.error('[agent_runtime] logRuntimeError failed:', err.message)
  }
}

// ---------------------------------------------------------------------------
// stageTrace
// Serialize one trace object and RPUSH to Redis episodic buffer. AC-3 / MEM-026.
// Never throws — Redis failures are logged via logRuntimeError.
// ---------------------------------------------------------------------------
async function stageTrace(agentId, sessionId, traceId, agentResult, config, redisClient) {
  if (!redisClient) {
    await logRuntimeError(agentId, sessionId, 'stageTrace: redisClient is null', traceId, config)
    return
  }
  const traceObj = {
    agentId,
    sessionId,
    traceId,
    timestamp:      new Date().toISOString(),
    task_summary:   agentResult.taskSummary   ?? null,
    result_summary: agentResult.resultSummary ?? null,
    success:        agentResult.success,
  }
  const serialized = JSON.stringify(traceObj)
  const key = `${config.runtime_redis_buffer_prefix}:${agentId}:${sessionId}:traces`
  try {
    await redisClient.rpush(key, serialized)
    await redisClient.expire(key, config.runtime_session_ttl_seconds)
  } catch (err) {
    await logRuntimeError(agentId, sessionId, err.message, traceId, config)
  }
}

// ---------------------------------------------------------------------------
// consolidateSession
// Read all staged traces, consolidate via configured model, write ONE L1 log,
// then delete the Redis key. On API failure: log and retain key for retry.
// ---------------------------------------------------------------------------
async function consolidateSession(agentId, sessionId, config, redisClient) {
  const key       = `${config.runtime_redis_buffer_prefix}:${agentId}:${sessionId}:traces`
  const rawTraces = await redisClient.lrange(key, 0, -1)
  if (rawTraces.length === 0) return

  const traces = rawTraces.map(t => JSON.parse(t))

  const tracesJson = JSON.stringify(traces, null, 2)
  const prompt = `You are consolidating episodic memory traces for agent: ${agentId}.\n\nDo not summarize content belonging to a different agent's namespace.\n\nTraces (JSON array):\n${tracesJson}\n\nProduce a JSON object with exactly these top-level fields:\n{\n  "agentId": "${agentId}",\n  "overarching_task_objective": string,\n  "tools_invoked": string[],\n  "decisions_made": string[],\n  "friction_encountered": string[],\n  "final_outcome": string\n}\n\nReturn only valid JSON. No prose outside the JSON object.`

  let response
  try {
    response = await anthropic.messages.create({
      model:      config.runtime_consolidation_model,
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    })
  } catch (err) {
    await logRuntimeError(agentId, sessionId, err.message, 'consolidateSession', config)
    return
  }

  const consolidatedLog = JSON.parse(response.content[0].text)
  writeL1Sync(consolidatedLog, config, config.mnemoDir, agentId)
  await redisClient.del(key)
}

// ---------------------------------------------------------------------------
// querySharedKnowledge
// Handler for the query_shared_knowledge tool. Returns top-3 results from
// the shared namespace. Errors propagate to caller — no silent catch. AC-5 / TECH §3.4.
// ---------------------------------------------------------------------------
async function querySharedKnowledge(query, config, redisClient) {
  if (config.shared_namespace_key === undefined) {
    throw new Error('RUNTIME_CONFIG_ERROR: missing key: shared_namespace_key')
  }
  const sharedNamespace = config.shared_namespace_key
  const retrievalConfig = { ...config, agent_namespace: sharedNamespace }
  const results = await retrieve(
    config.mnemoDir, sharedNamespace, query, retrievalConfig, null, redisClient, 'context'
  )
  return results.slice(0, 3)
}

// ---------------------------------------------------------------------------
// runAgent
// Universal entry point. Enforces PRE-FLIGHT READ → TASK → POST-TASK WRITE
// for every invocation regardless of calling surface. AC-1 / MEM-026 / MEM-027.
//
// Caller contract for session consolidation (AC-4 / DEF-005):
//   consolidateSession is NOT auto-triggered from within runAgent. The triggering
//   mechanism (session-end signal, cron, explicit call) is determined at the call
//   site layer (see TECH §9). Callers are responsible for invoking
//   consolidateSession(agentId, sessionId, config, config.redisClient) at session
//   close. consolidateSession is exported as part of the public API.
// ---------------------------------------------------------------------------
async function runAgent(agentId, task, config, agentClient) {
  validateRuntimeConfig(config)

  const redisClient = config.redisClient ?? null
  const sessionId   = crypto.randomUUID()
  const traceId     = crypto.randomUUID()

  const l2Results = await retrieve(
    config.mnemoDir, agentId, task.query, config, null, redisClient, 'context'
  )

  const isolatedContext = { agentId, l2Results, task }

  const agentResult = { success: false, output: null, error: null }
  try {
    const result        = await agentClient(isolatedContext, task)
    agentResult.success = true
    agentResult.output  = result
  } catch (err) {
    agentResult.error = err.message
  }

  const taskStr   = task.query ?? String(task)
  const resultStr = String(agentResult.output ?? agentResult.error ?? '')
  agentResult.taskSummary   = taskStr.slice(0, 200)
  agentResult.resultSummary = resultStr.slice(0, 500)

  await stageTrace(agentId, sessionId, traceId, agentResult, config, redisClient)

  return { result: agentResult.output, sessionId, traceId }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  runAgent,
  stageTrace,
  consolidateSession,
  querySharedKnowledge,
  logRuntimeError,
  validateRuntimeConfig,
}
