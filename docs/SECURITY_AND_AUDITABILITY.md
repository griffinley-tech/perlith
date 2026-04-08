# Security, Auditability, and Provenance

## The Problem with Invisible Memory

Most AI agent memory systems store facts in opaque databases — vector stores, graph databases, key-value caches. When an agent makes a decision based on a remembered fact, you cannot easily answer:

- Where did this fact come from?
- When was it learned?
- Has it been modified since?
- What other facts were considered and rejected?
- Who (or what agent) authored it?

This is the auditability gap. It matters most in exactly the situations where AI agents are most useful: long-running workflows, multi-agent systems, and autonomous decision-making.

## Git as the Audit Trail

Perlith stores every memory as a plain markdown file and commits every change to git. This means the entire history of an agent's knowledge is available through tools developers already know:

```bash
# When was this fact learned?
git log --follow src/agent-coder/L2_semantic/topics/MEM-20260408-agent-co-0003.md

# What changed in the last dream cycle?
git diff HEAD~1

# Who wrote this fact? (which agent, which session)
git blame src/agent-coder/L2_semantic/topics/MEM-20260408-agent-co-0003.md

# What did the agent know on March 15?
git log --before="2026-03-15" --oneline src/agent-coder/
```

No custom tooling. No dashboard. No query language to learn. Just git.

## Temporal Edges: Non-Destructive Updates

When a fact changes, Perlith does not overwrite the old version. Instead, it:

1. Sets `valid_until` on the old fact (it was true until now)
2. Creates a new fact with `valid_from` set to now
3. Links them with a `superseded_by_edge`

This means you can always ask: "What did the agent believe at time T?" The `as_of` parameter in `retrieve()` does exactly this — it queries the agent's knowledge as it existed at any point in time.

Old facts are never deleted. They move through statuses: `active` → `SUPERSEDED` → eventually archived. The full chain of belief revision is preserved.

## Content Integrity

Every L2 (semantic) fact carries a `content_hash` — a SHA-256 digest of the canonicalized body text. If a file is modified outside of Perlith's write path, the hash mismatch is detectable:

```javascript
const { verifyHash } = require('perlith')
const result = verifyHash(memoryFile)
// { valid: false, memId: 'MEM-...', path: '...' }
```

## Shared Namespace Governance

In multi-agent systems, shared facts require access control. Perlith enforces:

- **Write authorization** (MEM-032): Only designated agents can write to the shared namespace
- **Confidence floors** (MEM-033): Shared facts must exceed a minimum confidence score (default: 0.85)
- **Conflict detection**: When two agents assert contradictory facts about the same subject, the higher-confidence fact wins, with shared-namespace facts breaking ties

Every shared write is logged to `shared_promotion_log.jsonl` with the source agent, timestamp, and original fact ID.

## What Perlith Does Not Do

- **No encryption at rest.** Memory files are plaintext. Use filesystem permissions and disk encryption for sensitive data.
- **No network calls.** Perlith is local-only. No telemetry, no analytics, no version checks.
- **No authentication.** The MCP server trusts all local connections. Run it behind your own auth layer if needed.

These are intentional scope decisions for v0.1. They keep the system simple and auditable. Future versions may add optional encryption and auth — but the local-first, plaintext-auditable default will always remain.

## For Compliance Teams

If you need to demonstrate that your AI agent system maintains a complete audit trail:

1. Every memory write produces a git commit with timestamp and content
2. Every fact has provenance metadata (source agent, source episode, confidence score)
3. No fact is ever silently overwritten — temporal edges preserve the full revision history
4. The entire knowledge base can be exported as a directory of markdown files
5. Standard git forensics tools (log, blame, diff, bisect) work out of the box
