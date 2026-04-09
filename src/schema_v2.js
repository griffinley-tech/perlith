// SPDX-License-Identifier: Apache-2.0
'use strict'
// SPDX-License-Identifier: Apache-2.0

// schema_v2.js — Schema V2: bi-temporal fields, provenance metadata, hash integrity


const fs     = require('fs')
const fsP    = require('fs').promises
const path   = require('path')
const crypto = require('crypto')
const yaml   = require('js-yaml')

// ---------------------------------------------------------------------------
// Hash canonicalization — shared contract for both write and retrieval paths.
// Any change here invalidates all stored hashes (requires re-hash migration).
// ---------------------------------------------------------------------------

// Strip YAML frontmatter, normalize line endings to LF, return canonical string.
function canonicalizeBody(text) {
  const withoutFrontmatter = stripFrontmatter(text)
  return withoutFrontmatter.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

// Extract body text below the closing --- of YAML frontmatter.
function stripFrontmatter(text) {
  const match = text.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)
  if (!match) return text
  return match[1]
}

// Compute SHA-256 hex of canonicalized body. Input: raw file text or body text.
function hashBody(text) {
  const canonical = canonicalizeBody(text)
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// File read with legacy defaults
// ---------------------------------------------------------------------------

// Parse a raw .md string into { frontMatter, body }. Does NOT throw on missing V2 fields.
function parseRaw(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) throw new Error('SCHEMA_VIOLATION: missing YAML frontmatter block')
  const frontMatter = yaml.load(match[1])
  const body = (match[2] || '').trim()
  return { frontMatter, body }
}

// Apply legacy defaults for V2 fields that may be absent on pre-V2 files.
// ONLY call this in readMemoryFile — never at the caller level.
function applyLegacyDefaults(frontMatter) {
  const fm = { ...frontMatter }
  if (fm.valid_from  === undefined) fm.valid_from  = fm.created ?? null
  if (fm.valid_until === undefined) fm.valid_until = null
  if (fm.confidence_score === undefined) fm.confidence_score = null
  if (fm.content_hash     === undefined) fm.content_hash     = null
  if (fm.source_agent     === undefined) fm.source_agent     = null
  if (fm.retrieval_history === undefined) {
    fm.retrieval_history = fm.created ? [fm.created] : []
  }
  return fm
}

// Read a memory file, parse YAML+body, apply legacy defaults. Returns { frontMatter, body, filePath }.
async function readMemoryFile(filePath) {
  const raw = await fsP.readFile(filePath, 'utf8')
  const { frontMatter, body } = parseRaw(raw)
  const fm = applyLegacyDefaults(frontMatter)
  return { frontMatter: fm, body, filePath }
}

// ---------------------------------------------------------------------------
// Hash verification
// ---------------------------------------------------------------------------

// Verify content_hash for a loaded memory record.
// Legacy (content_hash=null) → { valid: true, legacy: true }.
// Mismatch → { valid: false, memId, path }.
function verifyHash(file) {
  const { frontMatter, body, filePath } = file
  if (frontMatter.content_hash === null || frontMatter.content_hash === undefined) {
    return { valid: true, legacy: true }
  }
  const recomputed = crypto.createHash('sha256').update(canonicalizeBody(body), 'utf8').digest('hex')
  if (recomputed !== frontMatter.content_hash) {
    return { valid: false, memId: frontMatter.id, path: filePath }
  }
  return { valid: true, legacy: false }
}

// ---------------------------------------------------------------------------
// Integrity log
// ---------------------------------------------------------------------------

// Append a mismatch entry to _meta/integrity_log.jsonl (sync, no try/catch per ledger rule).
function appendIntegrityLog(metaDir, entry) {
  const logPath = path.join(metaDir, 'integrity_log.jsonl')
  const line = JSON.stringify(entry) + '\n'
  fs.appendFileSync(logPath, line, 'utf8')
}

// ---------------------------------------------------------------------------
// Frontmatter V2 construction
// ---------------------------------------------------------------------------

// Build a V2 YAML frontmatter string from a fields object.
// Caller provides all fields — no defaults applied here.
function buildFrontmatterV2(fields) {
  return `---\n${yaml.dump(fields, { lineWidth: 120 }).trimEnd()}\n---\n`
}

// ---------------------------------------------------------------------------
// Retrieval history management
// ---------------------------------------------------------------------------

// Append a retrieval timestamp to retrieval_history on disk.
// Truncates to maxHistory entries (oldest dropped first).
// Reads and rewrites the full file — no try/catch (errors propagate per ledger rule).
async function appendRetrievalTimestamp(filePath, timestamp, maxHistory) {
  const raw = await fsP.readFile(filePath, 'utf8')
  const { frontMatter, body } = parseRaw(raw)
  const fm = applyLegacyDefaults(frontMatter)

  const history = [...(fm.retrieval_history || []), timestamp]
  fm.retrieval_history = history.length > maxHistory
    ? history.slice(history.length - maxHistory)
    : history

  const updated = buildFrontmatterV2(fm) + '\n' + body + '\n'
  await fsP.writeFile(filePath, updated, 'utf8')
}

// ---------------------------------------------------------------------------
// Supersession helper
// ---------------------------------------------------------------------------

// Set valid_until on an existing file before superseding it.
// No try/catch — errors propagate to caller.
async function setValidUntil(filePath, timestamp) {
  const raw = await fsP.readFile(filePath, 'utf8')
  const { frontMatter, body } = parseRaw(raw)
  const fm = applyLegacyDefaults(frontMatter)
  fm.valid_until = timestamp
  const updated = buildFrontmatterV2(fm) + '\n' + body + '\n'
  await fsP.writeFile(filePath, updated, 'utf8')
}

// Invalidate a memory file: sets BOTH valid_until AND status='INVALID' in one rewrite.
// RULE-DRM-001: file is never deleted. setValidUntil() alone is NOT sufficient — it
// does not write status. Using invalidateMemory() is the only correct path for INVALIDATE ops.


// atomically with the status/valid_until write (OQ-2 resolution). Existing callers
// pass no 3rd arg — behavior unchanged.
// No try/catch — errors propagate to caller.
async function invalidateMemory(filePath, timestamp, edgeFields = null) {
  const raw = await fsP.readFile(filePath, 'utf8')
  const { frontMatter, body } = parseRaw(raw)
  const fm = applyLegacyDefaults(frontMatter)
  fm.valid_until = timestamp
  fm.status      = 'INVALID'
  if (edgeFields) fm.superseded_by_edge = edgeFields
  const updated = buildFrontmatterV2(fm) + '\n' + body + '\n'
  await fsP.writeFile(filePath, updated, 'utf8')
}

// Supersede a memory file: sets valid_until, status='SUPERSEDED', and superseded_by_edge
// in one atomic writeFile. Used for UPDATE snapshots (AC-02). Same pattern as
// invalidateMemory but with SUPERSEDED status for facts that were true but replaced.
// No try/catch — errors propagate to caller.
async function supersedeMemory(filePath, timestamp, edgeFields) {
  const raw = await fsP.readFile(filePath, 'utf8')
  const { frontMatter, body } = parseRaw(raw)
  const fm = applyLegacyDefaults(frontMatter)
  fm.valid_until = timestamp
  fm.status      = 'SUPERSEDED'
  if (edgeFields) fm.superseded_by_edge = edgeFields
  const updated = buildFrontmatterV2(fm) + '\n' + body + '\n'
  await fsP.writeFile(filePath, updated, 'utf8')
}

module.exports = {
  canonicalizeBody,
  hashBody,
  readMemoryFile,
  verifyHash,
  appendIntegrityLog,
  buildFrontmatterV2,
  appendRetrievalTimestamp,
  setValidUntil,
  invalidateMemory,
  supersedeMemory,
}
