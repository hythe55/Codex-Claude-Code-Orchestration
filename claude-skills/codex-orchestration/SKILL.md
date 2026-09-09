---
name: codex-orchestration
description: Delegate work from Claude Code to OpenAI Codex/GPT models as real background workers. Use when a GPT model is a better fit, especially for computer/browser work, cheap parallel work, independent verification, or tasks that should continue after the current Claude turn ends.
---

# Codex orchestration

Run Codex from the top-level Claude Code session using the Bash tool with `run_in_background: true`. This is intentionally not a Claude subagent: the real Codex CLI runs with its own model and native tooling, while Claude Code owns the background process lifecycle.

## Core workflow

1. Choose the Codex model explicitly. Use the model the user requested; for computer/UI work, prefer `gpt-5.6-luna` when no model was specified.
2. Start Codex from the relevant project directory with a concrete prompt. For unattended work, prefer Codex's automatic approval reviewer:

   ```bash
   codex --approve-for-me exec --model gpt-5.6-luna --cd "$PWD" --skip-git-repo-check "<task>"
   ```

3. Run that Bash call with `run_in_background: true` and return the background task ID to the conversation state.
4. Continue any useful foreground work. It is valid to give the user a final response while Codex is still running.
5. When the top-level background task completes, Claude Code re-invokes this session. Read the completed task output if necessary, incorporate Codex's result, and continue or report the result to the user.

Do not busy-poll. Let Claude Code's native background-task completion wake the top-level session.

## Prompting Codex

Tell Codex exactly what it owns, whether it may edit files, and what result Claude needs back. For implementation work, tell it to inspect the existing code before editing and to report files changed, tests run, and unresolved issues. For computer/browser work, tell it to use its available computer tooling rather than merely describing UI steps.

Avoid having Claude and Codex edit the same files concurrently. Use a separate worktree or give them disjoint scopes when parallel edits are needed.

## Follow-up work

For a simple follow-up, launching another background `codex exec` task is usually enough. If preserving a specific Codex thread matters, use `codex exec --json` for the original dispatch, capture the `thread_id` from the `thread.started` event, then run a background resume with `codex exec resume --model <model> <thread_id> "<follow-up>"`.

## Important limits

- Launch these jobs from the top-level Claude session, not from a Claude subagent. Top-level background Bash completion can wake the parent session; subagent-owned background commands do not have the same reliable resume behavior.
- The Claude Code process must remain alive for its native background-task completion to wake the session. Closing the local session can terminate or orphan its background command.
- Do not route Claude through an Anthropic API proxy for this workflow. The real `codex` executable is the worker, so Claude Remote Control and normal Anthropic authentication remain untouched.
- `--approve-for-me` is preferred for unattended work because it keeps approval handling inside Codex. Do not use Codex's dangerous sandbox-bypass flag unless the user explicitly asks for unrestricted execution and the environment is trusted.
