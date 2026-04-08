#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Perlith MCP Server launcher
// Usage: npx perlith-mcp
// Or add to Claude Code settings: "command": "npx perlith-mcp"

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverPath = join(__dirname, '..', 'src', 'mcp_server.mjs')

await import(serverPath)
