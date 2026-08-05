import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

function schemaNode(schema) {
  return {
    _schema: schema,
    _optional: false,
    _default: undefined,
    optional() { this._optional = true; return this; },
    default(value) { this._default = value; this._optional = true; return this; },
    min() { return this; },
    max() { return this; },
    int() { return this; },
  };
}

const z = {
  string: () => schemaNode({ type: "string" }),
  boolean: () => schemaNode({ type: "boolean" }),
  number: () => schemaNode({ type: "number" }),
  enum: (values) => schemaNode({ type: "string", enum: values }),
  array: (item) => schemaNode({ type: "array", items: item?._schema || {} }),
};

class LocalMcpServer {
  constructor(info) {
    this.info = info;
    this.tools = [];
    this.handlers = new Map();
  }

  tool(name, description, schema, handler) {
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(schema || {})) {
      const node = value?._schema ? value : schemaNode({});
      properties[key] = { ...node._schema, ...(node._default !== undefined ? { default: node._default } : {}) };
      if (!node._optional) required.push(key);
    }
    this.tools.push({
      name,
      description,
      inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
    });
    this.handlers.set(name, handler);
  }

  async connect() {
    process.stdin.setEncoding("utf8");
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) this.dispatch(line).catch((error) => console.error(error));
    });
  }

  async dispatch(line) {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (!Object.prototype.hasOwnProperty.call(request, "id") || request.method?.startsWith("notifications/")) return;
    try {
      let result;
      if (request.method === "initialize") {
        result = {
          protocolVersion: request.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
        };
      } else if (request.method === "tools/list") {
        result = { tools: this.tools };
      } else if (request.method === "tools/call") {
        const handler = this.handlers.get(request.params?.name);
        if (!handler) throw new Error(`Unknown tool: ${request.params?.name}`);
        result = await handler(request.params?.arguments || {});
      } else {
        throw new Error(`Unsupported MCP method: ${request.method}`);
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } })}\n`);
    }
  }
}

const jobs = new Map();
const activeSessions = new Map();
let metadataWrite = Promise.resolve();
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const metadataPath = process.env.CLAUDE_CODE_ORCHESTRATOR_STATE ||
  path.join(configDir, "claude-code-orchestrator.json");

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function configuredRoots() {
  const raw = process.env.CLAUDE_CODE_ALLOWED_ROOTS;
  const roots = raw ? raw.split(path.delimiter).filter(Boolean) : [process.cwd()];
  return roots.map((root) => path.resolve(root));
}

async function resolveCwd(input) {
  const candidate = path.resolve(input || process.cwd());
  const real = await fsp.realpath(candidate).catch(() => null);
  if (!real) throw new Error(`Working directory does not exist: ${candidate}`);
  const ok = configuredRoots().some((root) => {
    const relative = path.relative(root, real);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!ok) {
    throw new Error(`Working directory is outside CLAUDE_CODE_ALLOWED_ROOTS: ${real}`);
  }
  return real;
}

function encodedCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function projectSessionDir(cwd) {
  return path.join(configDir, "projects", encodedCwd(cwd));
}

async function readMetadata() {
  try {
    return JSON.parse(await fsp.readFile(metadataPath, "utf8"));
  } catch {
    return { sessions: {} };
  }
}

function updateMetadata(sessionId, patch) {
  const operation = metadataWrite.then(async () => {
    const data = await readMetadata();
    data.sessions ||= {};
    data.sessions[sessionId] = { ...(data.sessions[sessionId] || {}), ...patch };
    await fsp.mkdir(path.dirname(metadataPath), { recursive: true });
    const tempPath = `${metadataPath}.${process.pid}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tempPath, metadataPath);
    return data.sessions[sessionId];
  });
  metadataWrite = operation.catch(() => {});
  return operation;
}

function eventText(event) {
  const message = event?.message;
  if (!message) return "";
  const content = Array.isArray(message.content) ? message.content : [];
  return content.filter((part) => part?.type === "text").map((part) => part.text).join("");
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function startClaudeJob({ prompt, cwd, sessionId, resume, forkSession = false, title, model, permissionMode }) {
  const taskId = randomUUID();
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (sessionId) args.push("--session-id", sessionId);
  if (resume) args.push("--resume", resume);
  if (forkSession) args.push("--fork-session");
  if (title) args.push("--name", title);
  if (model) args.push("--model", model);
  if (permissionMode) args.push("--permission-mode", permissionMode);

  const child = spawn("claude", args, {
    cwd,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });

  let lineBuffer = "";
  const job = {
    taskId,
    sessionId: sessionId || resume || null,
    cwd,
    status: "running",
    startedAt: new Date().toISOString(),
    events: [],
    stderr: "",
    result: null,
  };

  let resolveDone;
  job.done = new Promise((resolve) => { resolveDone = resolve; });
  jobs.set(taskId, job);
  if (job.sessionId) activeSessions.set(job.sessionId, taskId);

  const consume = (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || "";
    for (const line of lines) {
      const event = parseLine(line);
      if (!event) continue;
      job.events.push(event);
      if (job.events.length > 200) job.events.shift();
      if (event.session_id) job.sessionId = event.session_id;
      if (event.type === "result") job.result = event;
    }
  };

  child.stdout.on("data", consume);
  child.stderr.on("data", (chunk) => {
    job.stderr = `${job.stderr}${chunk.toString()}`.slice(-12000);
  });
  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    resolveDone(job);
  });
  child.on("close", (code, signal) => {
    if (lineBuffer.trim()) consume("\n");
    job.exitCode = code;
    job.signal = signal;
    job.status = code === 0 ? "completed" : "failed";
    job.finishedAt = new Date().toISOString();
    if (job.sessionId) activeSessions.delete(job.sessionId);
    if (job.sessionId) {
      updateMetadata(job.sessionId, {
        cwd,
        updatedAt: job.finishedAt,
        ...(title ? { title } : {}),
      }).catch(() => {});
    }
    resolveDone(job);
  });

  job.cancel = () => child.kill();
  return job;
}

function jobView(job) {
  return {
    taskId: job.taskId,
    sessionId: job.sessionId,
    cwd: job.cwd,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    error: job.error,
    result: job.result ? {
      subtype: job.result.subtype,
      text: job.result.result,
      totalCostUsd: job.result.total_cost_usd,
      durationMs: job.result.duration_ms,
      numTurns: job.result.num_turns,
    } : null,
    stderr: job.status === "failed" ? job.stderr : undefined,
  };
}

function findJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  const taskId = activeSessions.get(id);
  return taskId ? jobs.get(taskId) : null;
}

async function sessionFiles(cwd) {
  const dir = projectSessionDir(cwd);
  const names = await fsp.readdir(dir).catch(() => []);
  return Promise.all(names.filter((name) => name.endsWith(".jsonl")).map(async (name) => {
    const filePath = path.join(dir, name);
    const stat = await fsp.stat(filePath);
    return { filePath, sessionId: name.slice(0, -5), updatedAt: stat.mtime.toISOString() };
  }));
}

function messageView(event) {
  const role = event.type === "user" ? "user" : event.type === "assistant" ? "assistant" : event.type;
  const text = eventText(event);
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  return {
    type: role,
    timestamp: event.timestamp,
    text: text || undefined,
    tool: content.find((part) => part?.type === "tool_use")?.name,
  };
}

async function readSession(sessionId, cwd, maxMessages = 50) {
  const filePath = path.join(projectSessionDir(cwd), `${sessionId}.jsonl`);
  const raw = await fsp.readFile(filePath, "utf8");
  const messages = raw.split(/\r?\n/).map(parseLine).filter(Boolean).map(messageView);
  return { sessionId, cwd, filePath, messages: messages.slice(-maxMessages) };
}

const server = new LocalMcpServer({ name: "claude-code-orchestrator", version: "0.1.0" });

server.tool("create_claude_thread", "Start a Claude Code session in the background.", {
  prompt: z.string(),
  cwd: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.enum(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]).optional(),
}, async ({ prompt, cwd: cwdInput, title, model, permissionMode }) => {
  try {
    const cwd = await resolveCwd(cwdInput);
    const sessionId = randomUUID();
    const job = startClaudeJob({ prompt, cwd, sessionId, title, model, permissionMode });
    await updateMetadata(sessionId, { cwd, title, createdAt: job.startedAt, updatedAt: job.startedAt });
    return textResult({ action: "created", ...jobView(job) });
  } catch (error) {
    return fail(error.message);
  }
});

server.tool("fork_claude_thread", "Fork a Claude Code session into a new background session.", {
  sessionId: z.string(),
  prompt: z.string(),
  cwd: z.string().optional(),
  title: z.string().optional(),
}, async ({ sessionId, prompt, cwd: cwdInput, title }) => {
  try {
    const cwd = await resolveCwd(cwdInput);
    if (activeSessions.has(sessionId)) return fail(`Session ${sessionId} is still running.`);
    const forkedId = randomUUID();
    const job = startClaudeJob({ prompt, cwd, sessionId: forkedId, resume: sessionId, forkSession: true, title });
    await updateMetadata(forkedId, { cwd, title, forkedFrom: sessionId, createdAt: job.startedAt, updatedAt: job.startedAt });
    return textResult({ action: "forked", sourceSessionId: sessionId, ...jobView(job) });
  } catch (error) {
    return fail(error.message);
  }
});

server.tool("send_message_to_claude_thread", "Send a follow-up prompt to an existing Claude Code session in the background.", {
  sessionId: z.string(),
  prompt: z.string(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.enum(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]).optional(),
}, async ({ sessionId, prompt, cwd: cwdInput, model, permissionMode }) => {
  try {
    const cwd = await resolveCwd(cwdInput);
    if (activeSessions.has(sessionId)) return fail(`Session ${sessionId} already has a running task.`);
    const job = startClaudeJob({ prompt, cwd, resume: sessionId, model, permissionMode });
    return textResult({ action: "message_queued", ...jobView(job) });
  } catch (error) {
    return fail(error.message);
  }
});

server.tool("wait_for_claude_threads", "Wait for the first of several Claude Code tasks to finish or fail.", {
  taskIds: z.array(z.string()).min(1).max(8),
  timeoutMs: z.number().int().min(0).max(3600000).default(120000),
}, async ({ taskIds, timeoutMs }) => {
  const targets = taskIds.map(findJob).filter(Boolean);
  if (!targets.length) return fail("No matching Claude Code tasks were found. Use the taskId returned by create/send/fork.");
  const pending = targets.filter((job) => job.status === "running");
  if (!pending.length) return textResult({ completed: targets.map(jobView) });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const finished = await Promise.race(pending.map((job) => job.done));
  clearTimeout(timer);
  if (!finished) return textResult({ timedOut: true, tasks: targets.map(jobView) });
  return textResult({ timedOut: false, completed: jobView(finished), tasks: targets.map(jobView) });
});

server.tool("get_claude_task_status", "Read the status and final result of a Claude Code background task.", {
  taskId: z.string(),
}, async ({ taskId }) => {
  const job = findJob(taskId);
  return job ? textResult(jobView(job)) : fail(`Unknown Claude Code task: ${taskId}`);
});

server.tool("list_claude_threads", "List persisted Claude Code sessions for a permitted working directory.", {
  cwd: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  includeArchived: z.boolean().default(false),
}, async ({ cwd: cwdInput, limit, includeArchived }) => {
  try {
    const cwd = await resolveCwd(cwdInput);
    const metadata = await readMetadata();
    const files = await sessionFiles(cwd);
    const sessions = files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => ({
      ...item,
      ...(metadata.sessions?.[item.sessionId] || {}),
      activeTaskId: activeSessions.get(item.sessionId),
    })).filter((item) => includeArchived || !item.archived).slice(0, limit);
    return textResult({ cwd, sessions });
  } catch (error) {
    return fail(error.message);
  }
});

server.tool("read_claude_thread", "Read recent messages from a persisted Claude Code session.", {
  sessionId: z.string(),
  cwd: z.string().optional(),
  maxMessages: z.number().int().min(1).max(200).default(50),
}, async ({ sessionId, cwd: cwdInput, maxMessages }) => {
  try {
    const cwd = await resolveCwd(cwdInput);
    return textResult(await readSession(sessionId, cwd, maxMessages));
  } catch (error) {
    const job = findJob(sessionId);
    return job ? textResult({ sessionId, liveTask: jobView(job), events: job.events }) : fail(error.message);
  }
});

server.tool("set_claude_thread_title", "Set a local display title for a Claude Code session.", {
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string().optional(),
}, async ({ sessionId, title, cwd: cwdInput }) => {
  try {
    const cwd = await resolveCwd(cwdInput);
    return textResult({ sessionId, cwd, ...(await updateMetadata(sessionId, { cwd, title })) });
  } catch (error) {
    return fail(error.message);
  }
});

server.tool("set_claude_thread_pinned", "Pin or unpin a Claude Code session in local orchestrator metadata.", {
  sessionId: z.string(),
  pinned: z.boolean(),
  cwd: z.string().optional(),
}, async ({ sessionId, pinned, cwd: cwdInput }) => {
  try {
    const cwd = await resolveCwd(cwdInput);
    return textResult({ sessionId, cwd, ...(await updateMetadata(sessionId, { cwd, pinned })) });
  } catch (error) {
    return fail(error.message);
  }
});

server.tool("set_claude_thread_archived", "Archive or unarchive a Claude Code session in local orchestrator metadata.", {
  sessionId: z.string(),
  archived: z.boolean(),
  cwd: z.string().optional(),
}, async ({ sessionId, archived, cwd: cwdInput }) => {
  try {
    const cwd = await resolveCwd(cwdInput);
    return textResult({ sessionId, cwd, ...(await updateMetadata(sessionId, { cwd, archived })) });
  } catch (error) {
    return fail(error.message);
  }
});

server.tool("list_claude_projects", "List working-directory roots permitted for Claude Code orchestration.", {}, async () => {
  return textResult({ projects: configuredRoots() });
});

server.tool("close_claude_agent", "Stop a running Claude Code background task.", {
  taskId: z.string(),
}, async ({ taskId }) => {
  const job = findJob(taskId);
  if (!job) return fail(`Unknown Claude Code task: ${taskId}`);
  if (job.status === "running") job.cancel();
  return textResult({ action: "stop_requested", ...jobView(job) });
});

server.tool("resume_claude_agent", "Resume a Claude Code session with an optional follow-up prompt.", {
  sessionId: z.string(),
  prompt: z.string().default("Continue where you left off."),
  cwd: z.string().optional(),
}, async ({ sessionId, prompt, cwd: cwdInput }) => {
  try {
    const cwd = await resolveCwd(cwdInput);
    if (activeSessions.has(sessionId)) return fail(`Session ${sessionId} already has a running task.`);
    const job = startClaudeJob({ prompt, cwd, resume: sessionId });
    return textResult({ action: "resumed", ...jobView(job) });
  } catch (error) {
    return fail(error.message);
  }
});

server.tool("send_input_to_claude_agent", "Send new input to a Claude Code session; this is an alias for a session follow-up.", {
  sessionId: z.string(),
  message: z.string(),
  cwd: z.string().optional(),
}, async ({ sessionId, message, cwd }) => {
  try {
    const resolvedCwd = await resolveCwd(cwd);
    const activeTaskId = activeSessions.get(sessionId);
    if (activeTaskId) {
      return fail(`Session ${sessionId} already has a running task (${activeTaskId}). Wait for it to finish before sending input, or use a separate Claude session for parallel work.`);
    }
    const job = startClaudeJob({ prompt: message, cwd: resolvedCwd, resume: sessionId });
    return textResult({ action: "message_queued", ...jobView(job) });
  } catch (error) {
    return fail(error.message);
  }
});

async function main() {
  await server.connect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
