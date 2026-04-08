# Perlith

**Persistent memory for AI agents.** File-based. Git-native. Zero database.

```bash
npm install perlith
```

Perlith gives your AI agents memory that survives between sessions. Every fact is a markdown file. Every change is a git commit. No vector database, no infrastructure, no configuration — just files on disk.

---

## Quick Start

```javascript
const perlith = require('perlith')

// Initialize an agent
await perlith.initAgent('./memory', 'my-agent')

// Store a memory
await perlith.addMemory('./memory', 'my-agent', {
  layer: 'L1',
  body: 'The user prefers dark mode and uses VS Code.',
  tags: ['preferences', 'editor'],
})

// Retrieve memories
const config = await perlith.loadConfig('./memory', 'my-agent')
const results = await perlith.retrieve('./memory', 'my-agent', 'editor preferences', config)
```

## MCP Server

Plug Perlith into Claude Code, Cursor, or any MCP-compatible tool:

```json
{
  "mcpServers": {
    "perlith": {
      "command": "npx",
      "args": ["perlith-mcp"],
      "env": { "PERLITH_BASE_DIR": "./memory" }
    }
  }
}
```

Five tools available: `perlith_init`, `perlith_store`, `perlith_retrieve`, `perlith_list_agents`, `perlith_status`.

## How It Works

Perlith organizes memory into layers inspired by human cognition:

| Layer | Purpose | Analogy |
|-------|---------|---------|
| **L0** | Working memory | What you're thinking about right now |
| **L1** | Episodic | What happened today |
| **L2** | Semantic | Facts you know to be true |
| **L3** | Procedural | How you do things |
| **L4** | Archive | Things you mostly forgot |

Every memory is a markdown file with YAML frontmatter:

```yaml
---
id: MEM-20260408-my-agent-0001
type: episodic
layer: L1
created: 2026-04-08T12:00:00.000Z
salience: 1.0
tags: [preferences, editor]
status: active
---

The user prefers dark mode and uses VS Code.
```

Changes are committed to git automatically. Your agent's memory has a full audit trail — `git log`, `git diff`, `git blame` all work exactly as you'd expect.

## Architecture

- **Retrieval** uses a multi-stage pipeline: inverted index lookup, tag overlap scoring, salience weighting, recency decay, MMR diversity reranking, and conflict detection.
- **Temporal edges** track how facts evolve over time. When a fact is updated, the old version is preserved with a `superseded_by` edge pointing to the new one.
- **Shared namespaces** let multiple agents contribute to and read from a common knowledge base, with confidence-gated writes and conflict resolution.
- **Decay** follows the ACT-R cognitive model — memories that aren't accessed gradually lose salience and eventually archive.

## Why Files?

Most memory systems use vector databases. Perlith uses plain files because:

1. **Auditability.** `git log` shows every decision your agent ever made. Try that with pgvector.
2. **Portability.** Copy a directory. That's your backup. That's your migration.
3. **Debuggability.** Open a file in your editor. Read it. The memory is right there, in plain text.
4. **No infrastructure.** No Docker, no database, no connection strings. `npm install` and go.

## API Reference

### Agent Lifecycle
- `initAgent(baseDir, agentId)` — Create agent namespace
- `loadConfig(baseDir, agentId)` — Load agent configuration
- `generateId(baseDir, agentId)` — Generate a unique memory ID

### Memory Operations
- `addMemory(baseDir, agentId, { layer, body, tags })` — Store a memory
- `readMemory(filePath)` — Read a memory file
- `patchMemory(filePath, patches)` — Update frontmatter fields
- `archiveMemory(baseDir, agentId, filePath, memoryId, salience)` — Archive a memory
- `listActiveFiles(baseDir, agentId, layers)` — List active memories

### Retrieval
- `retrieve(baseDir, agentId, query, config, taskId, redisClient, options)` — Multi-stage retrieval

### Activation Contract
- `preFlight(baseDir, agentId, query, taskId, perlith, metaDir)` — Pre-task memory load
- `writeL1Sync(record, config, baseDir, agentId)` — Sync L1 write with fsync
- `postTask(record, preFlightResult, baseDir, agentId, metaDir)` — Post-task cleanup

## Requirements

- Node.js >= 20
- Git (for automatic commit tracking)

## License

Apache-2.0. See [LICENSE](LICENSE).

---

"Perlith" and "Griffinley" are trademarks of Griffinley LLC.
