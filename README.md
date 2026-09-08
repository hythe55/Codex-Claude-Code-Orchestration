# Codex ↔ Claude Code Orchestration

This repo provides both directions of local orchestration:

- **Codex → Claude Code:** a stdio MCP server that starts and manages Claude Code sessions in the background.
- **Claude Code → Codex:** a Claude Code skill that launches the real Codex CLI as a native top-level background Bash task. Claude can finish its current response while Codex keeps working, then Claude Code wakes the parent session when the background task completes.

## Codex → Claude Code

Install the server dependencies from this directory:

```powershell
npm install
```

Claude Code must already be installed and authenticated. The server runs the `claude` executable from `PATH`. If Claude subscription access is disabled for the organization, use an Anthropic API key or ask the administrator to enable access.

The Codex plugin uses `codex.mcp.json` and the `codex-skills/` directory so its MCP server and instructions are not auto-loaded by the Claude Code plugin.

For safety, the server only accepts paths under its current working directory by default. To allow more project roots, set `CLAUDE_CODE_ALLOWED_ROOTS` to a path-separated list before starting the MCP server.

The MCP configuration uses the stable user-level path `C:/Users/caden/plugins/claude-code-orchestrator/server/index.js`, because Codex does not expand Claude Code's `${CLAUDE_PLUGIN_ROOT}` variable.

The MCP server supports background session creation, follow-up prompts, resume, fork, wait, status, transcript reads, session listing, local titles, pin/archive metadata, and task stop requests.

## Claude Code → Codex

Codex must already be installed, authenticated, and available as `codex` on `PATH`.

Load this repository as a Claude Code plugin while developing it:

```powershell
claude --plugin-dir C:/Users/caden/plugins/claude-code-orchestrator
```

The Claude plugin exposes the `codex-orchestration` skill from `claude-skills/`. It deliberately does **not** proxy GPT models through the Anthropic API. Instead, the top-level Claude session launches a real Codex process with Bash `run_in_background: true`, for example:

```bash
codex --approve-for-me exec --model gpt-5.6-luna --cd "$PWD" --skip-git-repo-check "Inspect and test the UI issue, then report what you found."
```

Because Claude Code owns that background Bash task, the parent Claude session can finish its current turn and is automatically re-invoked when the Codex process exits. This keeps normal Claude authentication and Remote Control untouched and preserves Codex's own model/tool environment.

For resumable Codex work, dispatch with `codex exec --json`, record the `thread_id` from `thread.started`, and later use `codex exec resume` in another background Bash task.

## Limits

- Claude session forks copy conversation history, not filesystem state. Use separate Git worktrees for parallel edits.
- Claude and Codex should not edit the same files concurrently unless the work is isolated in separate worktrees.
- Claude → Codex dispatch should happen from the top-level Claude session. Background commands owned by Claude subagents do not have the same reliable parent wake behavior.
- The local Claude Code process must stay alive for native background-task completion to wake that session.
- Pinning, archiving, and titles for Codex → Claude are stored in local orchestrator metadata because Claude Code does not expose those same UI operations through its CLI.
