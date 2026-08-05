# Claude Code Orchestrator

This local Codex plugin exposes Claude Code sessions through a stdio MCP server.

It supports background session creation, follow-up prompts, resume, fork, wait, status, transcript reads, session listing, local titles, pin/archive metadata, and task stop requests.

## Setup

Install the server dependencies from this directory:

```powershell
npm install
```

Claude Code must already be installed and authenticated. The server runs the `claude` executable from `PATH`. If Claude subscription access is disabled for the organization, use an Anthropic API key or ask the administrator to enable access.

For safety, the server only accepts paths under its current working directory by default. To allow more project roots, set `CLAUDE_CODE_ALLOWED_ROOTS` to a path-separated list before starting the MCP server.

The MCP configuration uses the stable user-level path `C:/Users/caden/plugins/claude-code-orchestrator/server/index.js`, because Codex does not expand Claude Code's `${CLAUDE_PLUGIN_ROOT}` variable.

## Limits

Claude session forks copy conversation history, not filesystem state. Use separate Git worktrees for parallel edits. Pinning, archiving, and titles are stored in local orchestrator metadata because Claude Code does not expose those same UI operations through its CLI.
