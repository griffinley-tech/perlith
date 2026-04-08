// SPDX-License-Identifier: Apache-2.0
// Perlith MCP Server — stdio transport
// Exposes agent memory operations as MCP tools for Claude Code, Cursor, etc.
// Zero-config: point PERLITH_BASE_DIR at any directory. No database required.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs/promises'

// Bridge into Perlith's CJS core
const require = createRequire(import.meta.url)
const pInit = require('./init')
const pWrite = require('./write')
const pRetrieve = require('./retrieve')
const pPaths = require('./paths')

const BASE_DIR = process.env.PERLITH_BASE_DIR
  || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.perlith')

const server = new McpServer({
  name: 'perlith',
  version: '0.1.0',
}, {
  capabilities: { tools: {} },
})

// ---------------------------------------------------------------------------
// Tool 1: perlith_init — Initialize a new agent namespace
// ---------------------------------------------------------------------------
server.tool(
  'perlith_init',
  'Initialize a new agent memory namespace. Creates directory structure, config, and indexes.',
  { agent_id: z.string().describe('Agent identifier (e.g. "agent-coder", "agent-reviewer")') },
  async ({ agent_id }) => {
    const root = await pInit.initAgent(BASE_DIR, agent_id)
    return {
      content: [{
        type: 'text',
        text: `Initialized agent "${agent_id}" at ${root}\nLayers: L0 (working), L1 (episodic), L2 (semantic), L3 (procedural), L4 (archive)`,
      }],
    }
  },
)

// ---------------------------------------------------------------------------
// Tool 2: perlith_store — Store a memory
// ---------------------------------------------------------------------------
server.tool(
  'perlith_store',
  'Store a memory for an agent. Writes a markdown file with YAML frontmatter, updates indexes, and commits to git.',
  {
    agent_id: z.string().describe('Agent identifier'),
    body: z.string().describe('Memory content — a fact, observation, or decision'),
    tags: z.array(z.string()).optional().describe('Tags for retrieval indexing'),
    layer: z.enum(['L0', 'L1', 'L2']).optional().describe('Memory layer (default: L1 episodic)'),
  },
  async ({ agent_id, body, tags, layer }) => {
    await ensureAgent(agent_id)
    const targetLayer = layer || 'L1'
    const result = await pWrite.addMemory(BASE_DIR, agent_id, {
      layer: targetLayer,
      body,
      tags: tags || extractTags(body),
    })
    return {
      content: [{
        type: 'text',
        text: `Stored ${targetLayer} memory ${result.id}\nPath: ${result.filePath}\nTags: ${(tags || extractTags(body)).join(', ')}`,
      }],
    }
  },
)

// ---------------------------------------------------------------------------
// Tool 3: perlith_retrieve — Query agent memories
// ---------------------------------------------------------------------------
server.tool(
  'perlith_retrieve',
  'Query an agent\'s memories. Returns the most relevant memories ranked by tag overlap, salience, and recency.',
  {
    agent_id: z.string().describe('Agent identifier'),
    query: z.string().describe('Natural language query'),
    mode: z.enum(['factual', 'aggregation', 'context']).optional()
      .describe('Retrieval mode: factual (precise), aggregation (broad), context (session)'),
    max_results: z.number().optional().describe('Maximum results to return (default: 5)'),
  },
  async ({ agent_id, query, mode, max_results }) => {
    await ensureAgent(agent_id)
    const config = await pInit.loadConfig(BASE_DIR, agent_id)
    if (max_results) config.retrieval_max_results = max_results
    const results = await pRetrieve.retrieve(
      BASE_DIR, agent_id, query, config, null, null, { mode: mode || 'factual' },
    )
    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No memories found.' }] }
    }
    const formatted = results.map((r, i) => {
      const fm = r.frontMatter
      return `### ${i + 1}. ${fm.id} (score: ${(r.score ?? 0).toFixed(3)})\n` +
        `Layer: ${fm.layer} | Tags: ${(fm.tags || []).join(', ')} | ` +
        `Created: ${fm.created}\n\n${r.body || '(empty body)'}`
    }).join('\n\n---\n\n')
    return {
      content: [{ type: 'text', text: `Found ${results.length} memories:\n\n${formatted}` }],
    }
  },
)

// ---------------------------------------------------------------------------
// Tool 4: perlith_list_agents — List all agent namespaces
// ---------------------------------------------------------------------------
server.tool(
  'perlith_list_agents',
  'List all agent namespaces in the Perlith data directory with basic stats.',
  {},
  async () => {
    let entries
    try { entries = await fs.readdir(BASE_DIR, { withFileTypes: true }) }
    catch { return { content: [{ type: 'text', text: `No Perlith data at ${BASE_DIR}. Run perlith_init first.` }] } }

    const agents = []
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('_') || e.name === 'shared' || e.name === 'node_modules') continue
      const metaDir = pPaths.metaDir(BASE_DIR, e.name)
      const manifestPath = pPaths.manifestPath(BASE_DIR, e.name)
      let fileCount = 0
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
        fileCount = manifest.file_count || 0
      } catch { /* not initialized */ }
      agents.push({ id: e.name, files: fileCount })
    }

    if (agents.length === 0) {
      return { content: [{ type: 'text', text: `No agents found at ${BASE_DIR}. Run perlith_init to create one.` }] }
    }

    const lines = agents.map(a => `- **${a.id}** — ${a.files} memories`).join('\n')
    return {
      content: [{ type: 'text', text: `Perlith agents (${BASE_DIR}):\n\n${lines}` }],
    }
  },
)

// ---------------------------------------------------------------------------
// Tool 5: perlith_status — Detailed stats for an agent
// ---------------------------------------------------------------------------
server.tool(
  'perlith_status',
  'Get detailed status for an agent: memory counts per layer, config summary, last activity.',
  { agent_id: z.string().describe('Agent identifier') },
  async ({ agent_id }) => {
    let config, manifest
    try {
      config = await pInit.loadConfig(BASE_DIR, agent_id)
      manifest = await pInit.loadManifest(BASE_DIR, agent_id)
    } catch (err) {
      return { content: [{ type: 'text', text: `Agent "${agent_id}" not found. Run perlith_init first.` }] }
    }

    const layers = ['L0', 'L1', 'L2', 'L3', 'L4']
    const counts = {}
    for (const layer of layers) {
      const files = await pWrite.listActiveFiles(BASE_DIR, agent_id, [layer])
      counts[layer] = files.length
    }

    const lines = [
      `## Agent: ${agent_id}`,
      `Total memories: ${manifest.file_count || 0}`,
      '',
      '### Active memories by layer',
      ...layers.map(l => `- **${l}**: ${counts[l]}`),
      '',
      '### Config',
      `- Working memory cap: ${config.working_memory_cap}`,
      `- Retrieval max results: ${config.retrieval_max_results}`,
      `- Recency halflife: ${config.recency_halflife_days} days`,
      `- LLM model: ${config.llm_model}`,
    ]
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  },
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureAgent(agentId) {
  const configPath = pPaths.configPath(BASE_DIR, agentId)
  try { await fs.access(configPath) }
  catch { await pInit.initAgent(BASE_DIR, agentId) }
}

function extractTags(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 3)
    .slice(0, 10)
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  await fs.mkdir(BASE_DIR, { recursive: true })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  process.stderr.write(`Perlith MCP server error: ${err.message}\n`)
  process.exit(1)
})
