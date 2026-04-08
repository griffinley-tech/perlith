'use strict'
// SPDX-License-Identifier: Apache-2.0

const { simpleGit } = require('simple-git')

// Returns a simple-git instance scoped to the agent's perlith root
function getGit(agentRootPath) {
  return simpleGit(agentRootPath)
}

// Initialize a git repo at agentRootPath (idempotent)
async function gitInit(agentRootPath) {
  const git = getGit(agentRootPath)
  await git.init()
}

// Stage specific files and commit. Non-blocking from caller's perspective
// (caller does not await this unless it needs confirmation)
async function gitCommit(agentRootPath, message, files = ['.']) {
  try {
    const git = getGit(agentRootPath)
    await git.add(files)
    const status = await git.status()
    if (status.staged.length === 0 && status.modified.length === 0) return
    await git.commit(message)
  } catch (err) {
    // Git failures are non-fatal — log and continue
    console.error(`[perlith:git] commit failed: ${err.message}`)
  }
}

// Fire-and-forget git commit (for access updates on hot retrieval path)
function gitCommitAsync(agentRootPath, message, files = ['.']) {
  gitCommit(agentRootPath, message, files).catch(err => {
    console.error(`[perlith:git] async commit failed: ${err.message}`)
  })
}

// Resolve the git commit hash for a given file path (for audit trail)
async function gitFileHistory(agentRootPath, filePath) {
  const git = getGit(agentRootPath)
  const log = await git.log({ file: filePath, '--follow': null })
  return log.all
}

module.exports = {
  gitInit,
  gitCommit,
  gitCommitAsync,
  gitFileHistory,
}
