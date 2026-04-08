'use strict'
// SPDX-License-Identifier: Apache-2.0

const fs   = require('fs').promises
const path = require('path')
const p    = require('./paths')
const { readMemory, patchMemory, tokenize } = require('./write')
const { recencyScore } = require('./decay')
const { hybridRetrieve, mergeEscWithL2Results } = require('./esc')
const { augmentWithEdges } = require('./retrieve_edges')

// Startup guard: catch missing retrieval config at load time, not at query time
function validateRetrievalConfig(config) {
  const maxResults = config.retrieval_max_results ?? config.top_k
  if (!maxResults || maxResults < 1) {
    throw new Error('RETRIEVE_CONFIG_ERROR: retrieval_max_results (or top_k) must be a positive integer in activation_config.json')
  }
  const hasAnyCutoff = config.retrieval_overlap_cutoff_factual !== undefined
    || config.retrieval_overlap_cutoff_aggregation !== undefined
    || config.retrieval_overlap_cutoff_context !== undefined
    || config.retrieval_overlap_cutoff !== undefined
  if (!hasAnyCutoff) {
    console.warn('[retrieve] No overlap cutoff keys found in config — using hardcoded default 0.5')
  }
  
  // 0/negative is a config defect — disables the feature while callers still pass
  // include_edges:true, violating AC-02. Reject at startup. Values > 1 clamp silently
  // at the call site (AC-09).
  if (config.retrieve_edge_depth !== undefined && config.retrieve_edge_depth <= 0) {
    throw new Error('RETRIEVE_CONFIG_ERROR: retrieve_edge_depth must be >= 1 (0/negative disables the feature silently — violates edge-augmentation AC-02)')
  }
}

function resolveOverlapCutoff(config, mode) {
  const modeKey = {
    factual:     'retrieval_overlap_cutoff_factual',
    aggregation: 'retrieval_overlap_cutoff_aggregation',
    context:     'retrieval_overlap_cutoff_context',
  }[mode] ?? 'retrieval_overlap_cutoff_factual'
  if (config[modeKey] !== undefined) return config[modeKey]
  console.warn(`[retrieve] ${modeKey} not in config — falling back to retrieval_overlap_cutoff`)
  return config.retrieval_overlap_cutoff ?? 0.5
}

// Five-stage retrieval pipeline. Returns <=config.retrieval_max_results MemoryFile objects.

// Backward compat: typeof options === 'string' -> treat as { mode: options }.
async function retrieve(baseDir, agentId, query, config, taskId = null, redisClient = null, options = {}) {
  // OQ-3 backward compat shim: old callers pass mode as string in arg 7
  if (typeof options === 'string') options = { mode: options }
  const mode  = options.mode ?? 'factual'
  const asOf  = options.as_of ?? null
  const VALID_MODES = ['factual', 'aggregation', 'context']
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`RETRIEVE_MODE_ERROR: unknown mode '${mode}'`)
  }
  validateRetrievalConfig(config)
  const maxResults = config.retrieval_max_results ?? config.top_k ?? 5

  // Stage 1 -- Working memory check (immediate return on task_id match)
  if (taskId) {
    const hit = await workingMemoryCheck(baseDir, agentId, taskId)
    if (hit) return finalizeWorkingMemHit(hit, options, config, baseDir, agentId)
  }

  // Stage 2 -- Inverted index lookup -> candidate IDs only (MEM-034: own + shared)
  const { candidates, queryTokens } = await indexLookup(baseDir, agentId, query)
  const { candidates: sharedCandidates } = await indexLookupShared(baseDir, query)
  // Merge & deduplicate by ID (AC-14: dual-namespace query)
  const seenIds = new Set(candidates.map(c => c.id))
  const allCandidates = [...candidates]
  for (const sc of sharedCandidates) {
    if (!seenIds.has(sc.id)) { seenIds.add(sc.id); allCandidates.push(sc) }
  }
  const escResults = await queryEscIfEnabled(query, agentId, config, redisClient)
  if (allCandidates.length === 0 && escResults.length === 0) return []

  const [salienceMap, fileIndex] = await Promise.all([
    fs.readFile(p.salienceMapPath(baseDir, agentId), 'utf8').then(s => JSON.parse(s)).catch(() => ({})),
    buildFileIndex(baseDir, agentId),
  ])

  // Stage 3 -- Load candidate files and score; bi-temporal filter (MEM-011)
  const now    = Date.now()
  const nowIso = new Date(now).toISOString()
  const asOfIso = asOf || null
  const l2Scored = await loadAndScore(allCandidates, queryTokens, now, nowIso, salienceMap, fileIndex, config, asOfIso)
  const scored = mergeEscWithL2Results(l2Scored, escResults, config)

  if (scored.length === 0) return []
  if (scored.length === 1) {
    
    let single = [scored[0]]
    if (options.include_edges === true) {
      single = await augmentWithEdges(single, options, fileIndex, config, baseDir, agentId)
    }
    touchFile(single[0].filePath, single[0].frontMatter)
    return single
  }

  const top20 = scored.slice(0, 20)

  // Stage 4 -- Associative expansion
  const expanded = await associativeExpand(top20, fileIndex)

  // Stage 5 -- MMR re-ranking
  const overlapCutoff = resolveOverlapCutoff(config, mode)
  const reranked = mmrRerank(expanded, overlapCutoff, maxResults)

  // Stage 6 -- Conflict detection (AC-17/18/19, post-MMR)
  const { detectConflicts } = require('./conflict')
  let results = detectConflicts(reranked)

  // Stage 7 -- Edge augmentation (edge-augmentation AC-02): post-conflict, pre-touch.
  // Runs on _conflict_suppressed results too per OJ-4.
  if (options.include_edges === true) {
    results = await augmentWithEdges(results, options, fileIndex, config, baseDir, agentId)
  }

  for (const item of results) touchFile(item.filePath, item.frontMatter)
  return results
}

// --- ESC hybrid query helper ---

// Query ESC if enabled and redisClient is available. Returns [] on any failure (MEM-018).
async function queryEscIfEnabled(query, agentId, config, redisClient) {
  if (!config.esc_enabled || !redisClient) return []
  return hybridRetrieve(query, agentId, config, redisClient)
}

// --- Stage implementations ---

async function workingMemoryCheck(baseDir, agentId, taskId) {
  const workingDir = p.layerDir(baseDir, agentId, 'L0')
  let entries
  try { entries = await fs.readdir(workingDir) } catch { return null }
  for (const file of entries) {
    if (!file.endsWith('.md')) continue
    const filePath = path.join(workingDir, file)
    try {
      const { frontMatter } = await readMemory(filePath)
      if (frontMatter.status === 'active' && frontMatter.id.includes(taskId))
        return { filePath, frontMatter }
    } catch {}
  }
  return null
}

async function indexLookup(baseDir, agentId, query) {
  const indexPath = p.invertedIndexPath(baseDir, agentId)
  let index = {}
  try { index = JSON.parse(await fs.readFile(indexPath, 'utf8')) } catch {}
  const queryTokens = new Set(tokenize(query))
  const hits = {}
  for (const token of queryTokens) {
    for (const id of (index[token] || [])) hits[id] = (hits[id] || 0) + 1
  }
  const candidates = Object.entries(hits)
    .map(([id, count]) => ({ id, tokenHits: count / Math.max(queryTokens.size, 1) }))
    .sort((a, b) => b.tokenHits - a.tokenHits)
    .slice(0, 100)
  return { candidates, queryTokens }
}

// Shared namespace index lookup (AC-14)
async function indexLookupShared(baseDir, query) {
  const indexPath = p.sharedInvertedIndexPath(baseDir)
  let index = {}
  try { index = JSON.parse(await fs.readFile(indexPath, 'utf8')) } catch {}
  const queryTokens = new Set(tokenize(query))
  const hits = {}
  for (const token of queryTokens) {
    for (const id of (index[token] || [])) hits[id] = (hits[id] || 0) + 1
  }
  const candidates = Object.entries(hits)
    .map(([id, count]) => ({ id, tokenHits: count / Math.max(queryTokens.size, 1) }))
    .sort((a, b) => b.tokenHits - a.tokenHits)
    .slice(0, 100)
  return { candidates, queryTokens }
}


async function loadAndScore(candidates, queryTokens, now, nowIso, salienceMap, fileIndex, config, asOfIso) {
  const BATCH = 16, scored = []
  const validStatuses = asOfIso ? ['active', 'SUPERSEDED'] : ['active']
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH)
    const batchResults = await Promise.all(batch.map(async ({ id }) => {
      const filePath = fileIndex.get(id)
      if (!filePath) return null
      try {
        const { frontMatter, body } = await readMemory(filePath)
        if (!validStatuses.includes(frontMatter.status)) return null
        if (asOfIso) {
          if (frontMatter.valid_from && frontMatter.valid_from > asOfIso) return null
          if (frontMatter.valid_until != null && frontMatter.valid_until <= asOfIso) return null
        } else {
          if (frontMatter.valid_until != null && frontMatter.valid_until <= nowIso) return null
        }
        const ns = config.agent_namespace
        if (frontMatter.namespace && ns && frontMatter.namespace !== ns && frontMatter.namespace !== 'shared') return null
        const fileTags   = new Set(frontMatter.tags || [])
        const overlap    = [...queryTokens].filter(t => fileTags.has(t)).length
        const tagOverlap = fileTags.size > 0 ? overlap / fileTags.size : 0
        const salience   = salienceMap[id] ?? frontMatter.salience ?? 0
        const recency    = recencyScore(frontMatter.last_accessed, now, config.recency_halflife_days || 7)
        const score      = (tagOverlap * 0.4) + (salience * 0.4) + (recency * 0.2)
        const result = { filePath, frontMatter, body, score, tagSet: fileTags }
        if (asOfIso && frontMatter.superseded_by_edge) result.superseded_by_edge = frontMatter.superseded_by_edge
        return result
      } catch { return null }
    }))
    for (const r of batchResults) if (r) scored.push(r)
  }
  return scored.sort((a, b) => b.score - a.score)
}

async function associativeExpand(top20, fileIndex) {
  const seenIds   = new Set(top20.map(i => i.frontMatter.id))
  const expansion = []

  // Collect all linked IDs from top 5 results up front, then load in parallel
  const linkedPairs = []
  for (const item of top20.slice(0, 5)) {
    for (const linkedId of (item.frontMatter.linked || [])) {
      if (!seenIds.has(linkedId)) {
        seenIds.add(linkedId)
        const filePath = fileIndex.get(linkedId)
        if (filePath) linkedPairs.push({ filePath, parentScore: item.score })
      }
    }
  }

  const loaded = await Promise.all(linkedPairs.map(async ({ filePath, parentScore }) => {
    try {
      const { frontMatter, body } = await readMemory(filePath)
      if (frontMatter.status !== 'active') return null
      return { filePath, frontMatter, body, score: parentScore * 0.6, tagSet: new Set(frontMatter.tags) }
    } catch { return null }
  }))
  for (const r of loaded) if (r) expansion.push(r)

  return [...top20, ...expansion]
}

// Build a memoryId → filePath map from file_index.json — O(1), no filesystem walk

async function buildFileIndex(baseDir, agentId) {
  const raw = await fs.readFile(p.fileIndexPath(baseDir, agentId), 'utf8').catch(() => '{}')
  const obj = JSON.parse(raw)
  const sharedRaw = await fs.readFile(p.sharedFileIndexPath(baseDir), 'utf8').catch(() => '{}')
  const sharedObj = JSON.parse(sharedRaw)
  return new Map([...Object.entries(obj), ...Object.entries(sharedObj)])
}

function mmrRerank(candidates, overlapCutoff, maxResults) {
  const selected = []
  let remaining  = [...candidates]
  while (selected.length < maxResults && remaining.length > 0) {
    let best = null; let bestScore = -Infinity
    for (const item of remaining) {
      const maxOverlap = selected.length === 0 ? 0 :
        Math.max(...selected.map(s => tagOverlapRatio(item.tagSet, s.tagSet)))
      const mmrScore = item.score - (maxOverlap * overlapCutoff)
      if (mmrScore > bestScore) { best = item; bestScore = mmrScore }
    }
    if (!best) break
    selected.push(best)
    remaining = remaining.filter(r => r !== best)
  }
  return selected
}

function tagOverlapRatio(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0
  const intersection = [...setA].filter(t => setB.has(t)).length
  return intersection / Math.max(setA.size, setB.size)
}


// (OQ-2 resolution: working-memory hits receive edge augmentation for AC-02 consistency).
async function finalizeWorkingMemHit(hit, options, config, baseDir, agentId) {
  touchFile(hit.filePath, hit.frontMatter)
  if (options.include_edges !== true) return [hit]
  const fileIndex = await buildFileIndex(baseDir, agentId)
  const [augmented] = await augmentWithEdges([hit], options, fileIndex, config, baseDir, agentId)
  return [augmented]
}

function touchFile(filePath, frontMatter) {
  const updated = { ...frontMatter,
    last_accessed: new Date().toISOString(),
    access_count:  (frontMatter.access_count || 0) + 1,
  }
  patchMemory(filePath, updated).catch(() => {})
}

module.exports = { retrieve }
