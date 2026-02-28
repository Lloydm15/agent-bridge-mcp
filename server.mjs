#!/usr/bin/env node

/**
 * Mevoric — Unified memory + agent bridge for Claude Code.
 *
 * 12 tools:
 *   Memory:  retrieve_memories, store_conversation, judge_memories
 *   Bridge:  register_agent, list_agents, send_message, read_messages, broadcast
 *   Context: share_context, get_context
 *   Checkpoints: save_checkpoint, load_checkpoint
 *
 * 4 hook modes:
 *   --bootstrap-context  (SessionStart)
 *   --capture-prompt     (UserPromptSubmit)
 *   --check-messages     (UserPromptSubmit)
 *   --ingest             (Stop) — saves context + checkpoint + POSTs to memory server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync,
  readdirSync, unlinkSync, renameSync
} from 'fs';
import { resolve, dirname } from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { homedir, tmpdir, platform } from 'os';

// ============================================================
// Constants (configurable via environment variables)
// ============================================================

function getDefaultDataDir() {
  const p = platform();
  if (p === 'win32') {
    return resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'mevoric');
  }
  if (p === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', 'mevoric');
  }
  return resolve(process.env.XDG_DATA_HOME || resolve(homedir(), '.local', 'share'), 'mevoric');
}

// Support legacy AGENT_BRIDGE_DATA_DIR for backwards compat during migration
const DATA_DIR = process.env.MEVORIC_DATA_DIR || process.env.AGENT_BRIDGE_DATA_DIR || getDefaultDataDir();
const AGENTS_DIR = resolve(DATA_DIR, 'agents');
const MESSAGES_DIR = resolve(DATA_DIR, 'messages');
const CONTEXT_DIR = resolve(DATA_DIR, 'context');
const CURSORS_DIR = resolve(DATA_DIR, 'cursors');
const CHECKPOINTS_DIR = resolve(DATA_DIR, 'checkpoints');
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.MEVORIC_HEARTBEAT_MS || '15000', 10);
const STALE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3;
const DEAD_THRESHOLD_MS = parseInt(process.env.MEVORIC_DEAD_MS || '300000', 10);
const MESSAGE_TTL_MS = parseInt(process.env.MEVORIC_MESSAGE_TTL_MS || '3600000', 10);

// Memory server (newcode backend)
const MEMORY_SERVER_URL = process.env.MEVORIC_SERVER_URL
  || process.env.NEWCODE_SERVER_URL
  || 'http://192.168.2.100:4000';

// Session-level conversation ID for memory tools
const sessionConversationId = randomUUID();

// Write conversation ID to temp file so external tools can reference it
const CONVID_FILE = resolve(tmpdir(), 'mevoric-convid');
try { writeFileSync(CONVID_FILE, sessionConversationId); } catch {}

// ============================================================
// Agent State (in-memory, per-process)
// ============================================================

const agentId = `agent-${randomBytes(3).toString('hex')}`;
let agentName = process.env.MEVORIC_AGENT_NAME || process.env.AGENT_BRIDGE_NAME || null;
let agentBaseName = agentName;
const startedAt = new Date().toISOString();
let lastReadTimestamp = Date.now();
let heartbeatTimer = null;

// ============================================================
// Directory Setup
// ============================================================

function ensureDirs() {
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(MESSAGES_DIR, { recursive: true });
  mkdirSync(CONTEXT_DIR, { recursive: true });
  mkdirSync(CURSORS_DIR, { recursive: true });
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
}

// ============================================================
// Process Liveness Check
// ============================================================

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Agent File Operations
// ============================================================

function getAgentData() {
  return {
    id: agentId,
    name: agentName,
    baseName: agentBaseName || agentName,
    project: process.cwd().split(/[\\/]/).pop(),
    cwd: process.cwd(),
    pid: process.pid,
    startedAt,
    lastHeartbeat: new Date().toISOString()
  };
}

function writeAgentFile() {
  const data = JSON.stringify(getAgentData(), null, 2);
  const targetPath = resolve(AGENTS_DIR, `${agentId}.json`);
  const tmpPath = targetPath + '.tmp';
  try {
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try { writeFileSync(targetPath, data); } catch {}
  }
}

function removeAgentFile() {
  try { unlinkSync(resolve(AGENTS_DIR, `${agentId}.json`)); } catch {}
  try { unlinkSync(resolve(AGENTS_DIR, `${agentId}.json.tmp`)); } catch {}
}

function readAgentFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ============================================================
// Get All Agents (with staleness detection + cleanup)
// ============================================================

function getAllAgents() {
  const agents = [];
  let files;
  try {
    files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return agents;
  }

  const now = Date.now();

  for (const file of files) {
    const filePath = resolve(AGENTS_DIR, file);
    const agent = readAgentFile(filePath);
    if (!agent) continue;

    const heartbeatAge = now - new Date(agent.lastHeartbeat).getTime();
    const pidAlive = isProcessAlive(agent.pid);

    if (!pidAlive && agent.id !== agentId) {
      try { unlinkSync(filePath); } catch {}
      continue;
    }

    if (heartbeatAge > DEAD_THRESHOLD_MS && agent.id !== agentId) {
      try { unlinkSync(filePath); } catch {}
      continue;
    }

    agents.push({
      ...agent,
      status: heartbeatAge > STALE_THRESHOLD_MS ? 'stale' : 'active',
      isMe: agent.id === agentId
    });
  }

  return agents;
}

// ============================================================
// Cleanup
// ============================================================

function cleanOldMessages() {
  let files;
  try {
    files = readdirSync(MESSAGES_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  const cutoff = Date.now() - MESSAGE_TTL_MS;

  for (const file of files) {
    const timestamp = parseInt(file.split('-')[0], 10);
    if (!isNaN(timestamp) && timestamp < cutoff) {
      try { unlinkSync(resolve(MESSAGES_DIR, file)); } catch {}
    }
  }
}

// ============================================================
// Heartbeat
// ============================================================

function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    writeAgentFile();
    cleanOldMessages();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

// ============================================================
// Message Operations
// ============================================================

function writeMessage(to, toName, content, isBroadcast) {
  const now = Date.now();
  const rand = randomBytes(3).toString('hex');
  const msgId = `msg-${now}-${rand}`;
  const filename = `${now}-${rand}.json`;

  const message = {
    id: msgId,
    from: agentId,
    fromName: agentName,
    to: isBroadcast ? '*' : to,
    toName: isBroadcast ? null : toName,
    broadcast: isBroadcast,
    content,
    project: process.cwd().split(/[\\/]/).pop(),
    timestamp: new Date(now).toISOString()
  };

  const filePath = resolve(MESSAGES_DIR, filename);
  writeFileSync(filePath, JSON.stringify(message, null, 2), { flag: 'wx' });
  return message;
}

function readNewMessages(includeBroadcasts = true) {
  let files;
  try {
    files = readdirSync(MESSAGES_DIR).filter(f => f.endsWith('.json')).sort();
  } catch {
    return [];
  }

  const messages = [];

  for (const file of files) {
    const timestamp = parseInt(file.split('-')[0], 10);
    if (isNaN(timestamp) || timestamp <= lastReadTimestamp) continue;

    const filePath = resolve(MESSAGES_DIR, file);
    let msg;
    try {
      msg = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }

    if (msg.from === agentId) continue;

    const isForMe = msg.to === agentId || msg.toName === agentName;
    const isBroadcast = msg.broadcast && msg.to === '*';

    if (isForMe || (isBroadcast && includeBroadcasts)) {
      messages.push({
        ...msg,
        ageSeconds: Math.round((Date.now() - new Date(msg.timestamp).getTime()) / 1000)
      });
    }
  }

  if (files.length > 0) {
    const lastFile = files[files.length - 1];
    const lastTs = parseInt(lastFile.split('-')[0], 10);
    if (!isNaN(lastTs) && lastTs > lastReadTimestamp) {
      lastReadTimestamp = lastTs;
    }
  }

  return messages;
}

// ============================================================
// Resolve Agent Target (name or ID)
// ============================================================

function resolveAgent(nameOrId) {
  const agents = getAllAgents().filter(a => !a.isMe && a.status === 'active');

  const byId = agents.find(a => a.id === nameOrId);
  if (byId) return byId;

  const nameL = nameOrId.toLowerCase();
  const byName = agents
    .filter(a => a.name && a.name.toLowerCase() === nameL)
    .sort((a, b) => new Date(b.lastHeartbeat) - new Date(a.lastHeartbeat));
  if (byName.length > 0) return byName[0];

  const byBase = agents
    .filter(a => a.baseName && a.baseName.toLowerCase() === nameL)
    .sort((a, b) => new Date(b.lastHeartbeat) - new Date(a.lastHeartbeat));
  if (byBase.length > 0) return byBase[0];

  const partial = agents.filter(a => a.name && a.name.toLowerCase().includes(nameL));
  if (partial.length === 1) return partial[0];

  return null;
}

function resolveAllAgents(nameOrId) {
  const agents = getAllAgents().filter(a => !a.isMe && a.status === 'active');
  const nameL = nameOrId.toLowerCase();

  const byId = agents.find(a => a.id === nameOrId);
  if (byId) return [byId];

  const matches = agents.filter(a =>
    (a.name && a.name.toLowerCase() === nameL) ||
    (a.baseName && a.baseName.toLowerCase() === nameL)
  );
  if (matches.length > 0) return matches;

  const partial = agents.filter(a => a.name && a.name.toLowerCase().includes(nameL));
  return partial;
}

// ============================================================
// HTTP Helper (for memory server calls)
// ============================================================

async function memoryFetch(endpoint, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${MEMORY_SERVER_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Memory server timeout after ${timeoutMs}ms on ${endpoint}`);
    }
    throw new Error(`Memory server unreachable (${MEMORY_SERVER_URL}${endpoint}): ${err.message}`);
  }
}

// ============================================================
// Tool Handlers — Bridge
// ============================================================

async function handleRegister(args) {
  const name = args.name?.trim();
  if (!name) return { error: 'Name is required' };

  const agents = getAllAgents().filter(a => !a.isMe && a.status === 'active');
  let finalName = name;
  const nameLower = name.toLowerCase();
  const conflicts = agents.filter(a => a.name && a.name.toLowerCase() === nameLower);
  if (conflicts.length > 0) {
    const allNames = agents.map(a => a.name?.toLowerCase()).filter(Boolean);
    let suffix = 2;
    while (allNames.includes(`${nameLower}-${suffix}`)) suffix++;
    finalName = `${name}-${suffix}`;
  }

  agentName = finalName;
  agentBaseName = name;
  writeAgentFile();

  return {
    registered: true,
    id: agentId,
    name: agentName,
    baseName: name,
    project: process.cwd().split(/[\\/]/).pop(),
    cwd: process.cwd(),
    pid: process.pid,
    ...(finalName !== name ? { note: `Name "${name}" was taken, registered as "${finalName}"` } : {})
  };
}

async function handleListAgents() {
  const agents = getAllAgents();
  return {
    agents,
    totalActive: agents.filter(a => a.status === 'active').length,
    myId: agentId,
    myName: agentName
  };
}

async function handleSendMessage(args) {
  const { to, content } = args;
  if (!to) return { error: 'Target agent (to) is required' };
  if (!content) return { error: 'Message content is required' };

  const target = resolveAgent(to);
  if (!target) {
    const agents = getAllAgents().filter(a => !a.isMe && a.status === 'active');
    return {
      error: `No active agent found matching "${to}"`,
      availableAgents: agents.map(a => ({ id: a.id, name: a.name, project: a.project }))
    };
  }

  const msg = writeMessage(target.id, target.name, content, false);
  return {
    sent: true,
    messageId: msg.id,
    to: { id: target.id, name: target.name },
    timestamp: msg.timestamp
  };
}

async function handleReadMessages(args) {
  const includeBroadcasts = args.include_broadcasts !== false;
  const messages = readNewMessages(includeBroadcasts);
  return {
    messages,
    count: messages.length,
    myId: agentId,
    myName: agentName
  };
}

async function handleBroadcast(args) {
  const { content } = args;
  if (!content) return { error: 'Message content is required' };

  const agents = getAllAgents().filter(a => !a.isMe && a.status === 'active');
  const msg = writeMessage('*', null, content, true);

  return {
    broadcast: true,
    messageId: msg.id,
    activeRecipients: agents.length,
    timestamp: msg.timestamp
  };
}

// ============================================================
// Tool Handlers — Context
// ============================================================

function writeContextFile(name, content, uniqueId) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const suffix = uniqueId || agentId;
  const data = JSON.stringify({
    agentName: name,
    agentId: uniqueId || agentId,
    baseName: name,
    project: process.cwd().split(/[\\/]/).pop(),
    updatedAt: new Date().toISOString(),
    content
  }, null, 2);
  const targetPath = resolve(CONTEXT_DIR, `${safeName}--${suffix}.json`);
  const tmpPath = targetPath + '.tmp';
  try {
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try { writeFileSync(targetPath, data); } catch {}
  }
}

function readAllContextFiles() {
  let files;
  try {
    files = readdirSync(CONTEXT_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const contexts = [];
  for (const file of files) {
    try {
      const ctx = JSON.parse(readFileSync(resolve(CONTEXT_DIR, file), 'utf8'));
      contexts.push(ctx);
    } catch {
      continue;
    }
  }
  return contexts;
}

async function handleShareContext(args) {
  const { content } = args;
  if (!content) return { error: 'Content is required — dump what you know' };
  if (!agentName) return { error: 'Register with a name first (register_agent) before sharing context' };

  writeContextFile(agentName, content);

  return {
    shared: true,
    agentName,
    project: process.cwd().split(/[\\/]/).pop(),
    updatedAt: new Date().toISOString(),
    contentLength: content.length
  };
}

async function handleGetContext(args) {
  const { from } = args;

  if (from) {
    const safeName = from.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    let files;
    try {
      files = readdirSync(CONTEXT_DIR).filter(f => f.endsWith('.json'));
    } catch {
      return { found: false, error: `No shared context found for "${from}"` };
    }

    const matches = [];
    for (const file of files) {
      const basePart = file.replace(/\.json$/, '').split('--')[0];
      if (basePart === safeName) {
        try {
          const ctx = JSON.parse(readFileSync(resolve(CONTEXT_DIR, file), 'utf8'));
          matches.push(ctx);
        } catch { continue; }
      }
    }

    if (matches.length === 0) {
      return { found: false, error: `No shared context found for "${from}"` };
    }
    if (matches.length === 1) {
      return { found: true, context: matches[0] };
    }
    return { found: true, contexts: matches, count: matches.length };
  }

  const contexts = readAllContextFiles();
  return {
    contexts,
    count: contexts.length
  };
}

// ============================================================
// Tool Handlers — Checkpoints
// ============================================================

function writeCheckpointFile(name, sessionId, checkpointData) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const suffix = sessionId || agentId;
  const data = JSON.stringify({
    version: 1,
    agentName: name,
    project: process.cwd().split(/[\\/]/).pop(),
    sessionId: suffix,
    createdAt: new Date().toISOString(),
    ...checkpointData
  }, null, 2);
  const targetPath = resolve(CHECKPOINTS_DIR, `${safeName}--${suffix}.json`);
  const tmpPath = targetPath + '.tmp';
  try {
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try { writeFileSync(targetPath, data); } catch {}
  }
  return targetPath;
}

function readLatestCheckpoint(name) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  let files;
  try {
    files = readdirSync(CHECKPOINTS_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return null;
  }

  const matches = [];
  for (const file of files) {
    const basePart = file.replace(/\.json$/, '').split('--')[0];
    if (basePart === safeName) {
      try {
        const data = JSON.parse(readFileSync(resolve(CHECKPOINTS_DIR, file), 'utf8'));
        matches.push(data);
      } catch { continue; }
    }
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const age = Date.now() - new Date(matches[0].createdAt).getTime();
  if (age > CHECKPOINT_MAX_AGE_MS) return null;

  return matches[0];
}

async function handleSaveCheckpoint(args) {
  if (!agentName) return { error: 'Register with a name first (register_agent) before saving checkpoints' };

  const checkpoint = {
    task: args.task || null,
    files_touched: args.files_touched || [],
    key_decisions: args.key_decisions || [],
    notes: args.notes || ''
  };

  const path = writeCheckpointFile(agentName, agentId, checkpoint);

  return {
    saved: true,
    agentName,
    project: process.cwd().split(/[\\/]/).pop(),
    createdAt: new Date().toISOString(),
    path
  };
}

async function handleLoadCheckpoint(args) {
  const name = args.from || agentName;
  if (!name) return { error: 'Provide agent name via "from" parameter, or register first' };

  const checkpoint = readLatestCheckpoint(name);
  if (!checkpoint) {
    return { found: false, error: `No recent checkpoint found for "${name}" (max age: 24h)` };
  }

  const ageMin = Math.round((Date.now() - new Date(checkpoint.createdAt).getTime()) / 1000 / 60);
  return {
    found: true,
    ageMinutes: ageMin,
    checkpoint
  };
}

// ============================================================
// Tool Handlers — Memory (calls newcode HTTP server)
// ============================================================

async function handleRetrieveMemories(args) {
  const query = args.query;
  if (!query) return { error: 'query is required' };
  const userId = args.user_id || 'lloyd';

  try {
    const data = await memoryFetch('/retrieve', {
      query,
      user_id: userId,
      conversation_id: sessionConversationId
    }, 30000);

    const memories = data.memories || [];
    return {
      memories: memories.map(m => ({
        memory: m.memory,
        score: Math.round((m.score || 0) * 1000) / 1000,
        rank: m.rank
      })),
      conversation_id: sessionConversationId
    };
  } catch (err) {
    return { error: err.message, conversation_id: sessionConversationId };
  }
}

async function handleStoreConversation(args) {
  const userMessage = args.user_message;
  const assistantResponse = args.assistant_response;
  if (!userMessage || !assistantResponse) {
    return { error: 'Both user_message and assistant_response are required' };
  }
  const userId = args.user_id || 'lloyd';
  const convId = args.conversation_id || sessionConversationId;

  try {
    const data = await memoryFetch('/ingest', {
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: assistantResponse }
      ],
      user_id: userId,
      conversation_id: convId
    }, 60000);

    return { status: data.status || 'stored', conversation_id: convId };
  } catch (err) {
    return { error: err.message, conversation_id: convId };
  }
}

async function handleJudgeMemories(args) {
  const convId = args.conversation_id || sessionConversationId;
  const queryText = args.query_text;
  const responseText = args.response_text;
  if (!queryText || !responseText) {
    return { error: 'Both query_text and response_text are required' };
  }
  const userId = args.user_id || 'lloyd';

  try {
    const data = await memoryFetch('/feedback', {
      conversation_id: convId,
      user_id: userId,
      query_text: queryText,
      response_text: responseText
    }, 30000);

    return { status: data.status || 'judging', conversation_id: convId };
  } catch (err) {
    return { error: err.message, conversation_id: convId };
  }
}

// ============================================================
// Hook Helpers
// ============================================================

function resolveAgentName(cwd) {
  if (process.env.MEVORIC_AGENT_NAME) return process.env.MEVORIC_AGENT_NAME;
  if (process.env.AGENT_BRIDGE_NAME) return process.env.AGENT_BRIDGE_NAME;

  if (cwd) {
    const mcpPath = resolve(cwd, '.mcp.json');
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
      // Check both mevoric and legacy agent-bridge entries
      const entry = mcp.mcpServers?.['mevoric'] || mcp.mcpServers?.['agent-bridge'];
      const name = entry?.env?.MEVORIC_AGENT_NAME || entry?.env?.AGENT_BRIDGE_NAME;
      if (name) return name;
    } catch {}
  }

  try {
    const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const agent = readAgentFile(resolve(AGENTS_DIR, file));
      if (agent?.name && agent.cwd === cwd) return agent.name;
    }
  } catch {}

  return null;
}

function readMessagesForAgent(name, cursorTimestamp) {
  let files;
  try {
    files = readdirSync(MESSAGES_DIR).filter(f => f.endsWith('.json')).sort();
  } catch {
    return { messages: [], newCursor: cursorTimestamp };
  }

  const pending = [];
  let newCursor = cursorTimestamp;
  const nameLower = name.toLowerCase();

  for (const file of files) {
    const timestamp = parseInt(file.split('-')[0], 10);
    if (isNaN(timestamp) || timestamp <= cursorTimestamp) continue;

    const filePath = resolve(MESSAGES_DIR, file);
    let msg;
    try { msg = JSON.parse(readFileSync(filePath, 'utf8')); } catch { continue; }

    if (msg.fromName?.toLowerCase() === nameLower) continue;

    const isForMe = msg.toName?.toLowerCase() === nameLower || msg.to?.toLowerCase() === nameLower;
    const isBroadcast = msg.broadcast && msg.to === '*';

    if (isForMe || isBroadcast) {
      pending.push(msg);
    }

    if (timestamp > newCursor) newCursor = timestamp;
  }

  return { messages: pending, newCursor };
}

function readCursor(name) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const cursorPath = resolve(CURSORS_DIR, `${safeName}.cursor`);
  try {
    return parseInt(readFileSync(cursorPath, 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function writeCursor(name, timestamp) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const cursorPath = resolve(CURSORS_DIR, `${safeName}.cursor`);
  const tmpPath = cursorPath + '.tmp';
  try {
    writeFileSync(tmpPath, String(timestamp));
    renameSync(tmpPath, cursorPath);
  } catch {
    try { writeFileSync(cursorPath, String(timestamp)); } catch {}
  }
}

// ============================================================
// System tag stripping (shared by hooks)
// ============================================================

const TAG_PATTERNS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g,
  /<ide_selection>[\s\S]*?<\/ide_selection>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
];

function stripSystemTags(text) {
  let clean = text;
  for (const pat of TAG_PATTERNS) clean = clean.replace(pat, '');
  return clean.replace(/\n\s*\n/g, '\n').trim();
}

// ============================================================
// Tool Definitions
// ============================================================

const TOOLS = [
  // --- Memory tools ---
  {
    name: 'retrieve_memories',
    description: 'Search for memories relevant to a query.\nReturns memories ranked by relevance with feedback adjustments.\nCall this before responding to get context from past conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        user_id: { type: 'string', default: 'lloyd', description: 'User ID (default: lloyd)' }
      },
      required: ['query']
    }
  },
  {
    name: 'store_conversation',
    description: 'Store memories from a conversation exchange.\nExtracts facts, preferences, and rules from both the user message and assistant response.\nCall this after responding to save what was learned.\n\nIMPORTANT: Pass the COMPLETE user message and COMPLETE assistant response.\nDo NOT summarize or truncate. The full text is needed for accurate memory extraction.',
    inputSchema: {
      type: 'object',
      properties: {
        user_message: { type: 'string', description: 'The complete user message' },
        assistant_response: { type: 'string', description: 'The complete assistant response' },
        user_id: { type: 'string', default: 'lloyd', description: 'User ID (default: lloyd)' },
        conversation_id: { type: 'string', default: '', description: 'Conversation ID (uses session ID if blank)' }
      },
      required: ['user_message', 'assistant_response']
    }
  },
  {
    name: 'judge_memories',
    description: 'Run the feedback judge on memories retrieved during a conversation.\nEvaluates whether each retrieved memory was useful, correct, or irrelevant.\nCall this after responding to improve future retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'Conversation ID from the retrieval session' },
        query_text: { type: 'string', description: 'The original query text' },
        response_text: { type: 'string', description: 'The response text that used the memories' },
        user_id: { type: 'string', default: 'lloyd', description: 'User ID (default: lloyd)' }
      },
      required: ['conversation_id', 'query_text', 'response_text']
    }
  },
  // --- Bridge tools ---
  {
    name: 'register_agent',
    description: 'Register this agent with a human-readable name so other agents can find and message you. Call this at the start of a session.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'A short human-readable name for this agent (e.g., "frontend-dev", "reviewer", "planner")'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'list_agents',
    description: 'List all active agents across all tabs. Shows agent ID, name, project, and status.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'send_message',
    description: 'Send a message to a specific agent by name or ID. Use list_agents first to see who is available.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The name or ID of the target agent' },
        content: { type: 'string', description: 'The message content to send' }
      },
      required: ['to', 'content']
    }
  },
  {
    name: 'read_messages',
    description: 'Check for new messages sent to you since your last read. Returns unread messages in chronological order.',
    inputSchema: {
      type: 'object',
      properties: {
        include_broadcasts: { type: 'boolean', description: 'Whether to include broadcast messages (default: true)' }
      }
    }
  },
  {
    name: 'broadcast',
    description: 'Send a message to ALL active agents. Use sparingly — prefer direct messages when you know the recipient.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The message content to broadcast to all agents' }
      },
      required: ['content']
    }
  },
  {
    name: 'share_context',
    description: 'Share your accumulated working knowledge so other agents (even in other projects) can read it. Write a comprehensive dump of everything you know — files read, decisions made, key facts, current state. Context persists after your session ends.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Freeform text dump of everything you know that would be useful to another agent picking up where you left off' }
      },
      required: ['content']
    }
  },
  {
    name: 'get_context',
    description: 'Read shared context from another agent. Works even if that agent is no longer active — context persists across sessions. Call with no arguments to see all available contexts.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Name of the agent whose context you want to read (e.g., "nova-main"). Omit to get all shared contexts.' }
      }
    }
  },
  {
    name: 'save_checkpoint',
    description: 'Save a structured checkpoint of your current working state. Use this before context gets compressed, when switching tasks, or periodically during long sessions. The checkpoint will be auto-loaded when a new session starts with the same agent name.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'object',
          description: 'Current task state',
          properties: {
            description: { type: 'string', description: 'What you are working on' },
            status: { type: 'string', description: 'in_progress, blocked, or completed' },
            steps_completed: { type: 'array', items: { type: 'string' }, description: 'Steps already done' },
            steps_remaining: { type: 'array', items: { type: 'string' }, description: 'Steps left to do' }
          }
        },
        files_touched: { type: 'array', items: { type: 'string' }, description: 'File paths you have read or modified' },
        key_decisions: { type: 'array', items: { type: 'string' }, description: 'Important decisions made during this session' },
        notes: { type: 'string', description: 'Freeform notes — anything that does not fit the structured fields' }
      }
    }
  },
  {
    name: 'load_checkpoint',
    description: 'Load the most recent checkpoint for an agent. Defaults to your own checkpoints. Returns null if no checkpoint exists or if the most recent one is older than 24 hours.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Agent name to load checkpoint for (defaults to your own name)' }
      }
    }
  }
];

// ============================================================
// Tool Dispatcher
// ============================================================

async function handleToolCall(name, args) {
  switch (name) {
    // Memory
    case 'retrieve_memories': return handleRetrieveMemories(args);
    case 'store_conversation': return handleStoreConversation(args);
    case 'judge_memories': return handleJudgeMemories(args);
    // Bridge
    case 'register_agent': return handleRegister(args);
    case 'list_agents': return handleListAgents();
    case 'send_message': return handleSendMessage(args);
    case 'read_messages': return handleReadMessages(args);
    case 'broadcast': return handleBroadcast(args);
    // Context
    case 'share_context': return handleShareContext(args);
    case 'get_context': return handleGetContext(args);
    // Checkpoints
    case 'save_checkpoint': return handleSaveCheckpoint(args);
    case 'load_checkpoint': return handleLoadCheckpoint(args);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ============================================================
// MCP Server
// ============================================================

const server = new Server(
  { name: 'mevoric', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleToolCall(name, args || {});
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `Tool execution failed: ${err.message}`,
          tool: name,
          args
        }, null, 2)
      }],
      isError: true
    };
  }
});

// ============================================================
// CLI: --capture-prompt (UserPromptSubmit hook mode)
// ============================================================

async function runCapturePrompt() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  const sessionId = data.session_id || '';
  const prompt = data.prompt || '';
  if (!sessionId || !prompt) process.exit(0);

  const clean = stripSystemTags(prompt);
  if (clean.length < 5) process.exit(0);

  const tmp = tmpdir();
  writeFileSync(resolve(tmp, `mevoric-prompt-${sessionId}`), clean, 'utf8');
  process.exit(0);
}

// ============================================================
// CLI: --ingest (Stop hook mode)
// ============================================================
// Unified: saves context + auto-checkpoint + POSTs to memory server

async function runIngest() {
  ensureDirs();

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  const sessionId = data.session_id || '';
  const assistantMsg = data.last_assistant_message || '';
  if (!sessionId || !assistantMsg) process.exit(0);

  // Read user prompt saved by --capture-prompt
  const tmp = tmpdir();
  const promptPath = resolve(tmp, `mevoric-prompt-${sessionId}`);
  let userMsg = '';
  try {
    userMsg = readFileSync(promptPath, 'utf8');
  } catch {}

  const cleanAssistant = stripSystemTags(assistantMsg);
  if (!cleanAssistant || cleanAssistant.length < 50) process.exit(0);

  const name = process.env.MEVORIC_AGENT_NAME || process.env.AGENT_BRIDGE_NAME || findAgentNameForSession(sessionId);
  if (!name) process.exit(0);

  // --- 1. Save context file (agent-bridge behavior) ---
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const ctxPath = resolve(CONTEXT_DIR, `${safeName}--${sessionId}.json`);

  let existing = { exchanges: [] };
  try {
    const prev = JSON.parse(readFileSync(ctxPath, 'utf8'));
    if (prev.exchanges) existing = prev;
    else if (prev.content) existing = { exchanges: [{ role: 'context', content: prev.content }] };
  } catch {}

  existing.exchanges.push({
    timestamp: new Date().toISOString(),
    user: userMsg.slice(0, 2000),
    assistant: cleanAssistant.slice(0, 5000)
  });
  if (existing.exchanges.length > 20) {
    existing.exchanges = existing.exchanges.slice(-20);
  }

  const ctxData = JSON.stringify({
    agentName: name,
    baseName: name,
    project: process.cwd().split(/[\\/]/).pop(),
    updatedAt: new Date().toISOString(),
    sessionId,
    exchanges: existing.exchanges
  }, null, 2);

  const tmpCtx = ctxPath + '.tmp';
  try {
    writeFileSync(tmpCtx, ctxData);
    renameSync(tmpCtx, ctxPath);
  } catch {
    try { writeFileSync(ctxPath, ctxData); } catch {}
  }

  // --- 2. Auto-save checkpoint ---
  try {
    mkdirSync(CHECKPOINTS_DIR, { recursive: true });
    const cpData = JSON.stringify({
      version: 1,
      agentName: name,
      project: process.cwd().split(/[\\/]/).pop(),
      sessionId,
      createdAt: new Date().toISOString(),
      auto: true,
      task: {
        description: userMsg.slice(0, 200) || 'Session ended',
        status: 'interrupted'
      },
      files_touched: [],
      key_decisions: [],
      notes: cleanAssistant.slice(0, 500)
    }, null, 2);
    const cpPath = resolve(CHECKPOINTS_DIR, `${safeName}--${sessionId}.json`);
    const cpTmp = cpPath + '.tmp';
    writeFileSync(cpTmp, cpData);
    renameSync(cpTmp, cpPath);
  } catch {}

  // --- 3. POST to memory server /ingest (ported from Python auto-ingest.py) ---
  if (userMsg && cleanAssistant) {
    // Read conversation ID from temp file (written by MCP server process)
    let convId = '';
    try {
      convId = readFileSync(resolve(tmp, 'mevoric-convid'), 'utf8').trim();
    } catch {}
    if (!convId) convId = sessionId; // fallback

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      await fetch(`${MEMORY_SERVER_URL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: userMsg.slice(0, 10000) },
            { role: 'assistant', content: cleanAssistant.slice(0, 10000) }
          ],
          user_id: 'lloyd',
          conversation_id: convId
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
    } catch {} // Best-effort — don't block session exit

    // --- 4. POST to memory server /feedback (fire-and-forget) ---
    try {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), 5000);
      await fetch(`${MEMORY_SERVER_URL}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          user_id: 'lloyd',
          query_text: userMsg.slice(0, 5000),
          response_text: cleanAssistant.slice(0, 5000)
        }),
        signal: controller2.signal
      });
      clearTimeout(timer2);
    } catch {} // Best-effort
  }

  process.exit(0);
}

function findAgentNameForSession(sessionId) {
  try {
    const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'));
    const cwd = process.cwd();
    for (const file of files) {
      const agent = readAgentFile(resolve(AGENTS_DIR, file));
      if (agent && agent.name && agent.cwd === cwd) return agent.name;
    }
  } catch {}
  return null;
}

// ============================================================
// CLI: --check-messages (UserPromptSubmit hook mode)
// ============================================================

async function runCheckMessages() {
  ensureDirs();

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  const cwd = data.cwd || process.cwd();
  const name = resolveAgentName(cwd);
  if (!name) process.exit(0);

  const cursor = readCursor(name);
  const { messages, newCursor } = readMessagesForAgent(name, cursor);

  if (newCursor > cursor) {
    writeCursor(name, newCursor);
  }

  if (messages.length === 0) {
    process.exit(0);
  }

  const formatted = messages.map(m => {
    const from = m.fromName || m.from;
    const age = Math.round((Date.now() - new Date(m.timestamp).getTime()) / 1000);
    const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}min ago`;
    return `[MESSAGE FROM ${from}]: ${m.content} (${ageStr})`;
  }).join('\n\n');

  const output = {
    hookSpecificOutput: {
      hookEventName: data.hook_event_name || 'UserPromptSubmit',
      additionalContext: `--- INCOMING AGENT MESSAGES (${messages.length}) ---\n${formatted}\n--- END AGENT MESSAGES ---\nYou received ${messages.length} message(s) from other agents. Read and respond to them. Use send_message to reply if needed.`
    }
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// ============================================================
// CLI: --bootstrap-context (SessionStart hook mode)
// ============================================================

async function runBootstrapContext() {
  ensureDirs();

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  const cwd = data.cwd || process.cwd();
  const myName = resolveAgentName(cwd);
  if (!myName) process.exit(0);

  const myNameLower = myName.toLowerCase();

  let activeAgents = [];
  try {
    const agentFiles = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'));
    for (const file of agentFiles) {
      try {
        const agent = JSON.parse(readFileSync(resolve(AGENTS_DIR, file), 'utf8'));
        if (agent.name && agent.name.toLowerCase() !== myNameLower && isProcessAlive(agent.pid)) {
          activeAgents.push(agent);
        }
      } catch {}
    }
  } catch {}

  const mySessionId = data.session_id || '';
  const contexts = readAllContextFiles().filter(c => {
    if (c.sessionId && mySessionId && c.sessionId === mySessionId) return false;
    if (c.agentId && c.agentId === myName) return false;
    return true;
  });

  const cursor = readCursor(myName);
  const { messages, newCursor } = readMessagesForAgent(myName, cursor);
  if (newCursor > cursor) {
    writeCursor(myName, newCursor);
  }

  const checkpoint = readLatestCheckpoint(myName);

  if (activeAgents.length === 0 && contexts.length === 0 && messages.length === 0 && !checkpoint) {
    process.exit(0);
  }

  const parts = [];

  if (checkpoint) {
    const ageMin = Math.round((Date.now() - new Date(checkpoint.createdAt).getTime()) / 1000 / 60);
    const cpParts = [`--- CHECKPOINT (from previous session, ${ageMin}min ago) ---`];
    if (checkpoint.task) {
      if (checkpoint.task.description) cpParts.push(`Task: ${checkpoint.task.description}`);
      if (checkpoint.task.status) cpParts.push(`Status: ${checkpoint.task.status}`);
      if (checkpoint.task.steps_completed?.length) cpParts.push(`Completed: ${checkpoint.task.steps_completed.join(', ')}`);
      if (checkpoint.task.steps_remaining?.length) cpParts.push(`Remaining: ${checkpoint.task.steps_remaining.join(', ')}`);
    }
    if (checkpoint.files_touched?.length) cpParts.push(`Files: ${checkpoint.files_touched.join(', ')}`);
    if (checkpoint.key_decisions?.length) cpParts.push(`Decisions: ${checkpoint.key_decisions.join('; ')}`);
    if (checkpoint.notes) cpParts.push(`Notes: ${checkpoint.notes.slice(0, 1000)}`);
    cpParts.push('--- END CHECKPOINT ---');
    parts.push(cpParts.join('\n'));
  }

  if (activeAgents.length > 0) {
    parts.push(`ACTIVE AGENTS: ${activeAgents.map(a => `${a.name} (${a.project})`).join(', ')}`);
  }

  for (const ctx of contexts) {
    const ageMin = Math.round((Date.now() - new Date(ctx.updatedAt).getTime()) / 1000 / 60);
    let summary = '';
    if (ctx.content) {
      summary = ctx.content.slice(0, 3000);
    } else if (ctx.exchanges && ctx.exchanges.length > 0) {
      const recent = ctx.exchanges.slice(-3);
      summary = recent.map(e =>
        `User: ${(e.user || '').slice(0, 200)}\nAssistant: ${(e.assistant || '').slice(0, 500)}`
      ).join('\n---\n');
    }
    if (summary) {
      parts.push(`--- CONTEXT FROM ${ctx.agentName} (${ctx.project || 'unknown'}, updated ${ageMin}min ago) ---\n${summary}`);
    }
  }

  if (messages.length > 0) {
    const formatted = messages.map(m => {
      const from = m.fromName || m.from;
      const age = Math.round((Date.now() - new Date(m.timestamp).getTime()) / 1000);
      const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}min ago`;
      return `[MESSAGE FROM ${from}]: ${m.content} (${ageStr})`;
    }).join('\n\n');
    parts.push(`--- PENDING MESSAGES (${messages.length}) ---\n${formatted}`);
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: data.hook_event_name || 'SessionStart',
      additionalContext: `--- MEVORIC BOOTSTRAP ---\nYou are "${myName}". Mevoric connects you with other Claude Code sessions and provides persistent memory. Messages from other agents are delivered automatically before each prompt.\n\n${parts.join('\n\n')}\n--- END BOOTSTRAP ---`
    }
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// ============================================================
// Main
// ============================================================

if (process.argv.includes('--capture-prompt')) {
  runCapturePrompt().catch(() => process.exit(0));
} else if (process.argv.includes('--ingest')) {
  runIngest().catch(() => process.exit(0));
} else if (process.argv.includes('--check-messages')) {
  runCheckMessages().catch(() => process.exit(0));
} else if (process.argv.includes('--bootstrap-context')) {
  runBootstrapContext().catch(() => process.exit(0));
} else {
  async function main() {
    ensureDirs();
    cleanOldMessages();

    if (agentName) {
      const existing = getAllAgents().filter(a => a.status === 'active' && a.name?.toLowerCase() === agentName.toLowerCase());
      if (existing.length > 0) {
        const allNames = getAllAgents().map(a => a.name?.toLowerCase()).filter(Boolean);
        let suffix = 2;
        while (allNames.includes(`${agentName.toLowerCase()}-${suffix}`)) suffix++;
        agentName = `${agentBaseName}-${suffix}`;
      }
    }

    writeAgentFile();
    startHeartbeat();

    const cleanup = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      removeAgentFile();
    };
    process.on('exit', cleanup);
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('SIGINT', () => { cleanup(); process.exit(0); });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[Mevoric] Server running`);
    console.error(`[Mevoric] Agent ID: ${agentId}`);
    console.error(`[Mevoric] Data dir: ${DATA_DIR}`);
    console.error(`[Mevoric] Memory server: ${MEMORY_SERVER_URL}`);
  }

  main().catch(err => {
    console.error(`[Mevoric] Fatal: ${err.message}`);
    process.exit(1);
  });
}
