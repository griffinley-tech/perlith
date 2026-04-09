// SPDX-License-Identifier: Apache-2.0
'use strict'
// SPDX-License-Identifier: Apache-2.0

// activation_schema.js — L1 episodic activation record schema
// L1 episodic activation record schema + validator.
// Throws on any violation — never swallows silently (AC-03, AC-04).

const STANDARD_FRONTMATTER_FIELDS = [
  'id', 'type', 'layer', 'created', 'last_accessed', 'access_count',
  'salience', 'decay_rate', 'source_episode', 'linked', 'tags', 'status',
]

const L1_REQUIRED = [
  'activation_source',
  'task_id',
  'inputs',
  'outputs',
  'rules_triggered',
  'outcome',
]

const VALID_OUTCOMES = ['success', 'partial', 'blocked', 'failed']

// Load activation_sources enum from config at call time.
// Config is passed in — no hardcoded values, no module-level FS read.
function getValidSources(config) {
  if (!config || !Array.isArray(config.activation_sources)) {
    throw new Error('ACTIVATION_SCHEMA: config.activation_sources must be an array')
  }
  return config.activation_sources
}

// Validate the standard YAML front-matter fields required by existing Mnemos schema.
function validateFrontmatter(frontMatter) {
  for (const field of STANDARD_FRONTMATTER_FIELDS) {
    if (frontMatter[field] === undefined) {
      throw new Error(`SCHEMA_VIOLATION: missing standard front-matter field "${field}"`)
    }
  }
  if (frontMatter.type !== 'episodic') {
    throw new Error(`SCHEMA_VIOLATION: activation L1 records must have type "episodic", got "${frontMatter.type}"`)
  }
  if (frontMatter.layer !== 'L1') {
    throw new Error(`SCHEMA_VIOLATION: activation records must have layer "L1", got "${frontMatter.layer}"`)
  }
}

// Validate the six activation-specific required fields.
// Throws with the first violation found — not batched.
function validateActivationFields(record, config) {
  const validSources = getValidSources(config)

  for (const field of L1_REQUIRED) {
    if (record[field] === undefined || record[field] === null) {
      throw new Error(`SCHEMA_VIOLATION: missing required activation field "${field}"`)
    }
  }

  if (!validSources.includes(record.activation_source)) {
    throw new Error(
      `SCHEMA_VIOLATION: invalid activation_source "${record.activation_source}". ` +
      `Valid sources: ${validSources.join(', ')}`
    )
  }

  if (typeof record.task_id !== 'string' || !record.task_id.trim()) {
    throw new Error('SCHEMA_VIOLATION: task_id must be a non-empty string')
  }

  if (typeof record.inputs !== 'object' || Array.isArray(record.inputs)) {
    throw new Error('SCHEMA_VIOLATION: inputs must be a plain object')
  }

  if (typeof record.outputs !== 'object' || Array.isArray(record.outputs)) {
    throw new Error('SCHEMA_VIOLATION: outputs must be a plain object')
  }

  if (!Array.isArray(record.rules_triggered)) {
    throw new Error('SCHEMA_VIOLATION: rules_triggered must be an array of strings')
  }

  if (!VALID_OUTCOMES.includes(record.outcome)) {
    throw new Error(
      `SCHEMA_VIOLATION: invalid outcome "${record.outcome}". ` +
      `Valid outcomes: ${VALID_OUTCOMES.join(', ')}`
    )
  }
}

// Full validator — runs standard front-matter check then activation-specific check.
// Throws on first violation. Never returns false — either passes or throws.
function validateL1Record(record, config) {
  if (!record || typeof record !== 'object') {
    throw new Error('SCHEMA_VIOLATION: record must be a non-null object')
  }

  const frontMatter = record.frontMatter || record
  validateFrontmatter(frontMatter)
  validateActivationFields(record, config)
}

module.exports = {
  validateL1Record,
  L1_REQUIRED,
  VALID_OUTCOMES,
}
