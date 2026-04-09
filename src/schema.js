// SPDX-License-Identifier: Apache-2.0
'use strict'
// SPDX-License-Identifier: Apache-2.0

const yaml = require('js-yaml')

const REQUIRED_FIELDS = [
  'id', 'type', 'layer', 'created', 'last_accessed', 'access_count',
  'salience', 'decay_rate', 'source_episode', 'linked', 'tags', 'status',
]

const VALID_TYPES   = ['episodic', 'semantic', 'procedural', 'prospective', 'working']
const VALID_LAYERS  = ['L0', 'L1', 'L2', 'L3', 'L4']
const VALID_STATUSES = ['active', 'consolidated', 'archived', 'superseded']

const DECAY_RATE_DEFAULTS = { L0: 0.00, L1: 0.04, L2: 0.02, L3: 0.005, L4: 0.01 }

// Split a raw .md file string into {frontMatter: object, body: string}
function parse(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) throw new Error('SCHEMA_VIOLATION: missing YAML front-matter block')
  const frontMatter = yaml.load(match[1])
  const body = (match[2] || '').trim()
  return { frontMatter, body }
}

// Serialize frontMatter + body back to a .md string
function serialize(frontMatter, body) {
  return `---\n${yaml.dump(frontMatter, { lineWidth: 120 }).trimEnd()}\n---\n\n${body}\n`
}

// Validate a parsed frontMatter object. Throws on any violation.
function validate(frontMatter, body, layer) {
  for (const field of REQUIRED_FIELDS) {
    if (frontMatter[field] === undefined) {
      throw new Error(`SCHEMA_VIOLATION: missing required field "${field}"`)
    }
  }

  if (!VALID_TYPES.includes(frontMatter.type)) {
    throw new Error(`SCHEMA_VIOLATION: invalid type "${frontMatter.type}"`)
  }
  if (!VALID_LAYERS.includes(frontMatter.layer)) {
    throw new Error(`SCHEMA_VIOLATION: invalid layer "${frontMatter.layer}"`)
  }
  if (!VALID_STATUSES.includes(frontMatter.status)) {
    throw new Error(`SCHEMA_VIOLATION: invalid status "${frontMatter.status}"`)
  }
  if (typeof frontMatter.salience !== 'number' ||
      frontMatter.salience < 0 || frontMatter.salience > 1) {
    throw new Error(`SCHEMA_VIOLATION: salience must be a number in [0,1]`)
  }
  if (!Array.isArray(frontMatter.linked)) {
    throw new Error(`SCHEMA_VIOLATION: linked must be an array`)
  }
  if (!Array.isArray(frontMatter.tags)) {
    throw new Error(`SCHEMA_VIOLATION: tags must be an array`)
  }

  // One-fact rule: semantic files may only contain one declarative sentence in body
  if (frontMatter.type === 'semantic') {
    const sentences = body.match(/[^.!?]+[.!?]+/g) || []
    const declarative = sentences.filter(s => !s.trim().startsWith('#'))
    if (declarative.length > 1) {
      throw new Error(
        `SCHEMA_VIOLATION: semantic files must contain exactly one declarative sentence ` +
        `(found ${declarative.length})`
      )
    }
  }
}

// Build a new frontMatter object with correct defaults for a given layer
function buildFrontMatter(id, type, layer, tags = [], sourceEpisode = null) {
  const now = new Date().toISOString()
  return {
    id,
    type,
    layer,
    created:        now,
    last_accessed:  now,
    access_count:   0,
    salience:       1.0,
    decay_rate:     DECAY_RATE_DEFAULTS[layer] ?? 0.02,
    source_episode: sourceEpisode,
    linked:         [],
    tags,
    status:         'active',
    superseded_by:  null,
  }
}

// Update last_accessed and access_count on a frontMatter object
function touchFrontMatter(frontMatter) {
  return {
    ...frontMatter,
    last_accessed: new Date().toISOString(),
    access_count:  (frontMatter.access_count || 0) + 1,
  }
}

module.exports = {
  parse,
  serialize,
  validate,
  buildFrontMatter,
  touchFrontMatter,
  DECAY_RATE_DEFAULTS,
}
