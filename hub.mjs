#!/usr/bin/env node

/**
 * Mevoric Hub — Central HTTP server for cross-machine agent discovery and messaging.
 *
 * Endpoints:
 *   POST /api/agents/register   — Register or heartbeat an agent
 *   GET  /api/agents            — List all active agents
 *   DELETE /api/agents/:id      — Unregister an agent
 *   POST /api/messages          — Send a message to a specific agent
 *   POST /api/messages/broadcast — Broadcast to all agents
 *   GET  /api/messages/:agentId — Read pending messages for an agent
 *
 * Knowledge (with provenance + verification):
 *   POST /api/knowledge              — Store knowledge with provenance
 *   GET  /api/knowledge?project=X    — Query knowledge by project namespace
 *   GET  /api/knowledge/shared       — Get all cross-project shared knowledge
 *   GET  /api/knowledge/:id          — Get single item with provenance + verification
 *   POST /api/knowledge/:id/share    — Share knowledge to another project
 *   POST /api/knowledge/:id/verify   — Verify or challenge shared knowledge
 *
 * Tasks (delegation with results):
 *   POST /api/tasks                  — Create a task for an agent
 *   GET  /api/tasks?agent=X&status=Y — List tasks (filtered)
 *   GET  /api/tasks/:id              — Get task status + result
 *   POST /api/tasks/:id/complete     — Submit task result
 *   POST /api/tasks/fanout           — Send same task to multiple agents
 *   GET  /api/tasks/fanout/:id       — Check fan-out status
 *
 * Skills (agent capability registry):
 *   POST /api/skills                 — Register skills for an agent
 *   GET  /api/skills                 — List all skills (filterable)
 *   GET  /api/skills/:agent          — Get skills for specific agent
 *
 * Design references:
 *   - Namespace isolation: Memori (GibsonAI), Apache-2.0 — https://github.com/GibsonAI/memori
 *   - Provenance tracking: Collaborative Memory (arXiv:2505.18279)
 *   - Verification via debate: Du et al. 2023 (MIT CSAIL, ICLR 2025) — https://arxiv.org/abs/2305.14325
 *
 * Run: node hub.mjs
 * Port: MEVORIC_HUB_PORT env var or 4100
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const PORT = parseInt(process.env.MEVORIC_HUB_PORT || '4100', 10);
const STALE_MS = 15000;   // 15s — kept for internal use only
const DEAD_MS = 20000;    // 20s without heartbeat = gone (tab closed)
const MSG_TTL_MS = 3600000; // 1 hour message expiry
const KNOWLEDGE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days knowledge expiry

// Auto-responder — makes agents answer each other without human intervention
let autoRespondEnabled = process.env.MEVORIC_AUTO_RESPOND !== 'false'; // on by default
const AUTO_RESPOND_DELAY_MS = 8000; // wait 8 seconds before generating a response
const CORTEX_URL = process.env.CORTEX_URL || 'http://localhost:3100';
let autoRespondDailyLimit = 50; // max auto-responses per day

// Auto-respond tracking
const autoRespondStats = {
  enabled: autoRespondEnabled,
  totalResponses: 0,
  totalTokensEstimated: 0,
  todayResponses: 0,
  todayTokensEstimated: 0,
  todayDate: new Date().toISOString().slice(0, 10),
  history: [],          // last 50 responses with timestamps + token counts
  failedToday: 0,
  lastResponseAt: null,
  dailyLimit: autoRespondDailyLimit,
};

// Persistence directory (same dir as hub.mjs)
const __dirname = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_FILE = resolve(__dirname, 'knowledge.json');
const MESSAGE_LOG_FILE = resolve(__dirname, 'message-log.json');
const AUTO_RESPOND_STATS_FILE = resolve(__dirname, 'auto-respond-stats.json');
const ALERTS_FILE = resolve(__dirname, 'alerts.json');
const CORRECTIONS_FILE = resolve(__dirname, 'corrections.json');

// Load persisted stats on startup
try {
  const saved = JSON.parse(readFileSync(AUTO_RESPOND_STATS_FILE, 'utf8'));
  Object.assign(autoRespondStats, saved);
  autoRespondEnabled = autoRespondStats.enabled;
  autoRespondDailyLimit = autoRespondStats.dailyLimit;
  console.log(`[Mevoric Hub] Loaded auto-respond stats: ${autoRespondStats.totalResponses} total, enabled=${autoRespondEnabled}`);
} catch { /* first run */ }

function saveAutoRespondStats() {
  try {
    writeFileSync(AUTO_RESPOND_STATS_FILE, JSON.stringify(autoRespondStats, null, 2));
  } catch (err) {
    console.error(`[Mevoric Hub] Failed to save auto-respond stats: ${err.message}`);
  }
}

function resetDailyCountsIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (autoRespondStats.todayDate !== today) {
    autoRespondStats.todayResponses = 0;
    autoRespondStats.todayTokensEstimated = 0;
    autoRespondStats.failedToday = 0;
    autoRespondStats.todayDate = today;
  }
}

function recordAutoResponse(fromName, toName, tokensEstimated, success) {
  resetDailyCountsIfNeeded();
  if (success) {
    autoRespondStats.totalResponses++;
    autoRespondStats.todayResponses++;
    autoRespondStats.totalTokensEstimated += tokensEstimated;
    autoRespondStats.todayTokensEstimated += tokensEstimated;
    autoRespondStats.lastResponseAt = new Date().toISOString();
    autoRespondStats.history.push({
      from: fromName,
      to: toName,
      tokens: tokensEstimated,
      timestamp: new Date().toISOString()
    });
    // Keep last 50 entries
    if (autoRespondStats.history.length > 50) {
      autoRespondStats.history = autoRespondStats.history.slice(-50);
    }
  } else {
    autoRespondStats.failedToday++;
  }
  autoRespondStats.enabled = autoRespondEnabled;
  autoRespondStats.dailyLimit = autoRespondDailyLimit;
  saveAutoRespondStats();
}

// ============================================================
// In-memory stores
// ============================================================

const agents = new Map();   // agentId -> { id, name, baseName, project, cwd, pid, host, startedAt, lastHeartbeat, skills }
const messages = [];        // [{ id, from, fromName, to, toName, broadcast, content, project, timestamp }]
const tasks = new Map();    // taskId -> { id, from, fromName, to, toName, project, description, status, result, createdAt, updatedAt, timeout }
const skills = new Map();   // agentName -> [{ name, description, inputSchema }]

// Knowledge store — per-project namespaces with provenance and verification
// Design: Memori namespaces (GibsonAI) + Collaborative Memory provenance (arXiv:2505.18279)
const knowledge = new Map(); // knowledgeId -> { id, content, project, createdBy:{agent,project,host}, source, timestamp, shared, sharedWith[], verifications[] }

// Message history — permanent log of all messages (survives delivery/expiry)
let messageHistory = [];

// Alerts — cross-project notifications (server down, port changed, etc.)
const alerts = new Map(); // alertId -> { id, content, severity, project, agent, affectsProjects, timestamp, resolved, resolvedAt, resolvedBy }

// Corrections — user feedback that applies across all projects
const corrections = new Map(); // correctionId -> { id, content, project, agent, timestamp }

// ============================================================
// Knowledge Persistence — survives hub restarts
// ============================================================

function loadKnowledge() {
  try {
    const data = JSON.parse(readFileSync(KNOWLEDGE_FILE, 'utf8'));
    for (const item of data) {
      knowledge.set(item.id, item);
    }
    console.log(`[Mevoric Hub] Loaded ${knowledge.size} knowledge items from disk`);
  } catch {
    // No file yet or parse error — start fresh
  }
}

function saveKnowledge() {
  try {
    const data = [...knowledge.values()];
    writeFileSync(KNOWLEDGE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[Mevoric Hub] Failed to save knowledge: ${err.message}`);
  }
}

let knowledgeDirty = false;
function markKnowledgeDirty() {
  knowledgeDirty = true;
}

// Load on startup
loadKnowledge();

// ============================================================
// Message History Persistence — permanent log of all messages
// ============================================================

function loadMessageHistory() {
  try {
    messageHistory = JSON.parse(readFileSync(MESSAGE_LOG_FILE, 'utf8'));
    console.log(`[Mevoric Hub] Loaded ${messageHistory.length} message history entries from disk`);
  } catch {
    // No file yet — start fresh
  }
}

function saveMessageHistory() {
  try {
    writeFileSync(MESSAGE_LOG_FILE, JSON.stringify(messageHistory, null, 2));
  } catch (err) {
    console.error(`[Mevoric Hub] Failed to save message history: ${err.message}`);
  }
}

function logMessage(msg) {
  messageHistory.push({ ...msg });
  // Cap at 5000 entries to prevent unbounded growth
  if (messageHistory.length > 5000) {
    messageHistory = messageHistory.slice(-5000);
  }
  saveMessageHistory();
}

loadMessageHistory();

// ============================================================
// Alerts Persistence
// ============================================================

function loadAlerts() {
  try {
    const data = JSON.parse(readFileSync(ALERTS_FILE, 'utf8'));
    for (const item of data) alerts.set(item.id, item);
    console.log(`[Mevoric Hub] Loaded ${alerts.size} alerts from disk`);
  } catch { /* first run */ }
}

function saveAlerts() {
  try {
    writeFileSync(ALERTS_FILE, JSON.stringify([...alerts.values()], null, 2));
  } catch (err) {
    console.error(`[Mevoric Hub] Failed to save alerts: ${err.message}`);
  }
}

let alertsDirty = false;
function markAlertsDirty() { alertsDirty = true; }

loadAlerts();

// ============================================================
// Corrections Persistence
// ============================================================

function loadCorrections() {
  try {
    const data = JSON.parse(readFileSync(CORRECTIONS_FILE, 'utf8'));
    for (const item of data) corrections.set(item.id, item);
    console.log(`[Mevoric Hub] Loaded ${corrections.size} corrections from disk`);
  } catch { /* first run */ }
}

function saveCorrections() {
  try {
    writeFileSync(CORRECTIONS_FILE, JSON.stringify([...corrections.values()], null, 2));
  } catch (err) {
    console.error(`[Mevoric Hub] Failed to save corrections: ${err.message}`);
  }
}

let correctionsDirty = false;
function markCorrectionsDirty() { correctionsDirty = true; }

loadCorrections();

// ============================================================
// Cleanup timer — remove dead agents and expired messages
// ============================================================

setInterval(() => {
  const now = Date.now();

  for (const [id, agent] of agents) {
    const age = now - new Date(agent.lastHeartbeat).getTime();
    if (age > DEAD_MS) {
      agents.delete(id);
    }
  }

  // Remove expired messages
  const cutoff = now - MSG_TTL_MS;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (new Date(messages[i].timestamp).getTime() < cutoff) {
      messages.splice(i, 1);
    }
  }

  // Remove completed/failed tasks older than 1 hour, pending tasks older than 10 min
  for (const [id, task] of tasks) {
    const age = now - new Date(task.createdAt).getTime();
    if ((task.status === 'completed' || task.status === 'failed') && age > MSG_TTL_MS) {
      tasks.delete(id);
    } else if (task.status === 'pending' && age > 600000) {
      task.status = 'timeout';
      task.updatedAt = new Date().toISOString();
    }
  }

  // Remove expired knowledge (30 days)
  const knCutoff = now - KNOWLEDGE_TTL_MS;
  for (const [id, item] of knowledge) {
    if (new Date(item.timestamp).getTime() < knCutoff) {
      knowledge.delete(id);
      markKnowledgeDirty();
    }
  }

  // Persist knowledge if changed
  if (knowledgeDirty) {
    saveKnowledge();
    knowledgeDirty = false;
  }

  // Auto-resolve alerts older than 4 hours, remove resolved alerts older than 24 hours
  const alertAutoResolve = 4 * 60 * 60 * 1000;
  const alertExpiry = 24 * 60 * 60 * 1000;
  for (const [id, alert] of alerts) {
    const age = now - new Date(alert.timestamp).getTime();
    if (alert.resolved && age > alertExpiry) {
      alerts.delete(id);
      markAlertsDirty();
    } else if (!alert.resolved && age > alertAutoResolve) {
      alert.resolved = true;
      alert.resolvedAt = new Date().toISOString();
      alert.resolvedBy = 'auto-expire';
      markAlertsDirty();
    }
  }

  // Remove corrections older than 90 days
  const correctionExpiry = 90 * 24 * 60 * 60 * 1000;
  for (const [id, c] of corrections) {
    if (now - new Date(c.timestamp).getTime() > correctionExpiry) {
      corrections.delete(id);
      markCorrectionsDirty();
    }
  }

  // Persist alerts/corrections if changed
  if (alertsDirty) { saveAlerts(); alertsDirty = false; }
  if (correctionsDirty) { saveCorrections(); correctionsDirty = false; }
}, 30000);

// ============================================================
// Helpers
// ============================================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Summarize verification status for a knowledge item
// Consensus logic from MIT multiagent debate (Du et al. 2023):
// Multiple agents evaluate — majority determines status
function summarizeVerifications(verifications) {
  if (!verifications || verifications.length === 0) {
    return { status: 'unverified', confirmed: 0, challenged: 0, total: 0 };
  }
  const confirmed = verifications.filter(v => v.verdict === 'confirmed').length;
  const challenged = verifications.filter(v => v.verdict === 'challenged').length;
  const total = verifications.length;

  let status;
  if (challenged === 0 && confirmed > 0) status = 'verified';
  else if (confirmed === 0 && challenged > 0) status = 'disputed';
  else if (confirmed > challenged) status = 'mostly_verified';
  else if (challenged > confirmed) status = 'mostly_disputed';
  else status = 'contested'; // equal

  return { status, confirmed, challenged, total };
}

function getActiveAgents() {
  const now = Date.now();
  const result = [];
  for (const agent of agents.values()) {
    const age = now - new Date(agent.lastHeartbeat).getTime();
    result.push({
      ...agent,
      status: 'active'  // no stale state — you're either here or gone
    });
  }
  return result;
}

// ============================================================
// Auto-responder — when an agent gets a message and nobody reads
// it within 8 seconds, Ollama generates a response on their behalf
// ============================================================

// Call Cortex's quick-reply endpoint (uses Claude Haiku on Max plan — fast + free)
let llmQueue = Promise.resolve();

async function callLLM(userMessage, systemPrompt) {
  // Chain requests so they run one at a time
  const result = new Promise((resolve) => {
    llmQueue = llmQueue.then(async () => {
      try {
        console.log(`[Auto-Respond] Calling Cortex quick-reply (Haiku)...`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30 second max
        const resp = await fetch(`${CORTEX_URL}/api/quick-reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ systemPrompt, userMessage })
        });
        clearTimeout(timeout);
        const data = await resp.json();
        const content = data.reply || '';
        console.log(`[Auto-Respond] Cortex returned ${content.length} chars`);
        resolve(content || null);
      } catch (err) {
        const reason = err.name === 'AbortError' ? 'timed out after 30s' : err.message;
        console.error(`[Auto-Respond] Cortex call failed: ${reason}`);
        resolve(null);
      }
    });
  });
  return result;
}

function getProjectKnowledge(project, limit = 5) {
  const items = [...knowledge.values()]
    .filter(k => k.project === project)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
  return items.map(k => k.content).join('\n---\n');
}

// Get recent message history between two agents for conversation context
function getRecentConversation(agentA, agentB, limit = 6) {
  const relevant = messageHistory
    .filter(m =>
      (m.from === agentA && m.to === agentB) ||
      (m.from === agentB && m.to === agentA) ||
      (m.fromName === agentA && (m.to === agentB || m.toName === agentB)) ||
      (m.fromName === agentB && (m.to === agentA || m.toName === agentA))
    )
    .slice(-limit);
  return relevant;
}

async function tryAutoRespond(msg) {
  console.log(`[Auto-Respond] Triggered for message ${msg.id} (to: ${msg.toName || msg.to}, enabled: ${autoRespondEnabled})`);
  if (!autoRespondEnabled) return;
  if (msg.broadcast) return;

  // Check daily limit
  resetDailyCountsIfNeeded();
  if (autoRespondStats.todayResponses >= autoRespondDailyLimit) {
    console.log(`[Auto-Respond] Daily limit reached (${autoRespondDailyLimit}) — skipping`);
    return;
  }

  // Wait before responding — give the real agent a chance to answer
  await new Promise(r => setTimeout(r, AUTO_RESPOND_DELAY_MS));

  // Check if the message was already read (consumed from the queue)
  const stillPending = messages.find(m => m.id === msg.id);
  if (!stillPending) {
    console.log(`[Auto-Respond] Message ${msg.id} already consumed — skipping`);
    return;
  }
  console.log(`[Auto-Respond] Message still pending after ${AUTO_RESPOND_DELAY_MS}ms — generating response`);

  // Find the target agent's info
  let targetAgent = null;
  for (const agent of agents.values()) {
    if (agent.id === msg.to || agent.name === msg.toName ||
        agent.baseName === msg.toName) {
      targetAgent = agent;
      break;
    }
  }

  const agentName = targetAgent?.name || msg.toName || 'unknown';
  const agentProject = targetAgent?.project || 'unknown';
  const senderName = msg.fromName || msg.from || 'unknown';

  // Gather context: project knowledge + recent conversation
  const projectKnowledge = getProjectKnowledge(agentProject);
  const recentChat = getRecentConversation(
    msg.from || msg.fromName,
    msg.to || msg.toName
  );
  const chatHistory = recentChat
    .map(m => `${m.fromName || m.from}: ${m.content}`)
    .join('\n');

  const systemPrompt = `You are ${agentName}, an AI agent working on the ${agentProject} project.
You are having a conversation with ${senderName}.
Keep your responses concise and helpful. If you don't have enough context to answer, say so.
Do NOT use markdown formatting. Write plain text only.
${projectKnowledge ? `\nThings you know about your project:\n${projectKnowledge}` : ''}
${chatHistory ? `\nRecent conversation:\n${chatHistory}` : ''}`;

  console.log(`[Auto-Respond] Generating reply from ${agentName} to ${senderName}...`);
  const response = await callLLM(msg.content, systemPrompt);

  if (!response) {
    console.log(`[Auto-Respond] No response generated (Ollama may be unavailable)`);
    recordAutoResponse(agentName, senderName, 0, false);
    return;
  }

  // Rough token estimate: ~4 chars per token for input+output
  const inputLen = (systemPrompt.length + msg.content.length);
  const outputLen = response.length;
  const tokensEstimated = Math.round((inputLen + outputLen) / 4);

  // Store the reply as a message from the target back to the sender
  const replyMsg = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: targetAgent?.id || msg.to,
    fromName: agentName,
    to: msg.from,
    toName: msg.fromName,
    broadcast: false,
    content: response,
    project: agentProject,
    timestamp: new Date().toISOString(),
    autoGenerated: true
  };
  messages.push(replyMsg);
  logMessage(replyMsg);
  recordAutoResponse(agentName, senderName, tokensEstimated, true);
  console.log(`[Auto-Respond] Reply sent from ${agentName} → ${senderName} (${response.length} chars, ~${tokensEstimated} tokens)`);
}

// Auto-respond to broadcasts — each active agent responds individually
async function tryAutoRespondBroadcast(msg) {
  console.log(`[Auto-Respond] Broadcast received from ${msg.fromName || msg.from}: "${msg.content.slice(0, 80)}..."`);
  if (!autoRespondEnabled) return;

  resetDailyCountsIfNeeded();

  // Get all active agents, excluding the sender
  const activeAgents = getActiveAgents().filter(a =>
    a.id !== msg.from && a.name !== msg.fromName && a.status === 'active'
  );

  if (activeAgents.length === 0) {
    console.log(`[Auto-Respond] No active agents to respond to broadcast`);
    return;
  }

  // Deduplicate by baseName (same project may have multiple sessions)
  const seen = new Set();
  const uniqueAgents = activeAgents.filter(a => {
    const key = a.baseName || a.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[Auto-Respond] ${uniqueAgents.length} agents will respond: ${uniqueAgents.map(a => a.name).join(', ')}`);

  // Stagger responses so they appear one by one (3 second gaps)
  for (const agent of uniqueAgents) {
    if (autoRespondStats.todayResponses >= autoRespondDailyLimit) {
      console.log(`[Auto-Respond] Daily limit reached — stopping broadcast responses`);
      break;
    }

    try {
      // Gather context for this agent
      const projectKnowledge = getProjectKnowledge(agent.project);
      const senderName = msg.fromName || msg.from || 'unknown';

      const isProposalRequest = msg.content.includes('[PROPOSAL REQUEST]');
      const cleanContent = msg.content.replace('[PROPOSAL REQUEST] ', '');

      const systemPrompt = `You are ${agent.name}, an AI agent working on the ${agent.project} project.
${senderName} sent a message to ALL agents in the group chat.
${isProposalRequest ? `They are asking each agent to propose a plan. Start your response with [PLAN] and outline what you think should be done next for your project. Be specific and actionable.` : `Respond naturally and concisely. Only respond if you have something useful to add.`}
Do NOT use markdown formatting. Write plain text only. Keep it under 150 words.
${projectKnowledge ? `\nThings you know about your project:\n${projectKnowledge}` : ''}`;

      console.log(`[Auto-Respond] Generating response from ${agent.name}...`);
      const response = await callLLM(cleanContent, systemPrompt);

      if (!response) {
        console.log(`[Auto-Respond] ${agent.name} — no response generated`);
        recordAutoResponse(agent.name, senderName, 0, false);
        continue;
      }

      const tokensEstimated = Math.round((systemPrompt.length + cleanContent.length + response.length) / 4);

      const replyMsg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: agent.id,
        fromName: agent.name,
        to: '*',
        toName: null,
        broadcast: true,
        content: response,
        project: agent.project,
        timestamp: new Date().toISOString(),
        autoGenerated: true
      };
      messages.push(replyMsg);
      logMessage(replyMsg);
      recordAutoResponse(agent.name, senderName, tokensEstimated, true);
      console.log(`[Auto-Respond] ${agent.name} replied (${response.length} chars)`);

      // Stagger: wait 2 seconds between agent responses
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[Auto-Respond] Error from ${agent.name}: ${err.message}`);
      recordAutoResponse(agent.name, msg.fromName || 'unknown', 0, false);
    }
  }
}

// ============================================================
// Request handler
// ============================================================

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // POST /api/agents/register
    if (method === 'POST' && path === '/api/agents/register') {
      const body = await readBody(req);
      const { id, name, baseName, project, cwd, pid, ppid, host, sessionId, startedAt } = body;

      if (!id) return json(res, { error: 'id is required' }, 400);

      const existing = agents.get(id);
      agents.set(id, {
        id,
        name: name || (existing && existing.name) || null,
        baseName: baseName || name || null,
        project: project || null,
        cwd: cwd || null,
        pid: pid || null,
        ppid: ppid || (existing && existing.ppid) || null,
        host: host || null,
        sessionId: sessionId || (existing && existing.sessionId) || null,
        startedAt: startedAt || (existing && existing.startedAt) || new Date().toISOString(),
        lastHeartbeat: new Date().toISOString()
      });

      return json(res, { registered: true, id });
    }

    // GET /api/agents
    if (method === 'GET' && path === '/api/agents') {
      return json(res, { agents: getActiveAgents() });
    }

    // DELETE /api/agents/:id
    if (method === 'DELETE' && path.startsWith('/api/agents/')) {
      const id = path.split('/').pop();
      agents.delete(id);
      return json(res, { removed: true, id });
    }

    // POST /api/messages/broadcast
    if (method === 'POST' && path === '/api/messages/broadcast') {
      const body = await readBody(req);
      const { from, fromName, content, project } = body;

      if (!content) return json(res, { error: 'content is required' }, 400);

      const msg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: from || null,
        fromName: fromName || null,
        to: '*',
        toName: null,
        broadcast: true,
        content,
        project: project || null,
        timestamp: new Date().toISOString()
      };
      messages.push(msg);
      logMessage(msg);

      // Auto-respond to broadcasts from humans (not from other auto-responses)
      // Skip session summaries ("agentName finished:") — those are just prompt echoes
      if (!content.match(/^[\w:.-]+ finished:/) && from !== 'system') {
        tryAutoRespondBroadcast(msg).catch(err =>
          console.error(`[Auto-Respond Broadcast] Error: ${err.message}`)
        );
      }

      return json(res, { sent: true, messageId: msg.id });
    }

    // POST /api/messages
    if (method === 'POST' && path === '/api/messages') {
      const body = await readBody(req);
      const { from, fromName, to, toName, content, project } = body;

      if (!content) return json(res, { error: 'content is required' }, 400);
      if (!to) return json(res, { error: 'to is required' }, 400);

      const msg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: from || null,
        fromName: fromName || null,
        to,
        toName: toName || null,
        broadcast: false,
        content,
        project: project || null,
        timestamp: new Date().toISOString()
      };
      messages.push(msg);
      logMessage(msg);

      // Kick off auto-response in the background (don't block the response)
      tryAutoRespond(msg).catch(err =>
        console.error(`[Auto-Respond] Error: ${err.message}`)
      );

      return json(res, { sent: true, messageId: msg.id });
    }

    // GET /api/messages/log — browse message history
    if (method === 'GET' && path === '/api/messages/log') {
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const sorted = [...messageHistory].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);
      return json(res, { messages: sorted, count: sorted.length, total: messageHistory.length });
    }

    // DELETE /api/messages/log/:id — delete a specific message from history
    if (method === 'DELETE' && path.startsWith('/api/messages/log/')) {
      const msgId = path.split('/api/messages/log/')[1];
      const before = messageHistory.length;
      messageHistory = messageHistory.filter(m => m.id !== msgId);
      if (messageHistory.length === before) {
        return json(res, { error: 'Message not found' }, 404);
      }
      saveMessageHistory();
      return json(res, { deleted: true, id: msgId });
    }

    // DELETE /api/messages/log — clear all message history
    if (method === 'DELETE' && path === '/api/messages/log') {
      messageHistory = [];
      saveMessageHistory();
      return json(res, { deleted: true, cleared: true });
    }

    // GET /api/messages/:agentId?since=ISO&name=agentName
    if (method === 'GET' && path.startsWith('/api/messages/')) {
      const agentId = path.split('/').pop();
      const since = url.searchParams.get('since');
      const agentNameParam = url.searchParams.get('name');
      const sinceTime = since ? new Date(since).getTime() : 0;

      const result = [];
      const toRemove = [];

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime <= sinceTime) continue;
        if (msg.from === agentId) continue;

        const isForMe = msg.to === agentId ||
          (agentNameParam && msg.toName === agentNameParam);
        const isBroadcast = msg.broadcast && msg.to === '*';

        if (isForMe || isBroadcast) {
          result.push({
            ...msg,
            ageSeconds: Math.round((Date.now() - msgTime) / 1000)
          });
          // Mark direct messages for removal after read
          if (isForMe && !isBroadcast) {
            toRemove.push(i);
          }
        }
      }

      // Remove consumed direct messages (reverse order to keep indices valid)
      for (let i = toRemove.length - 1; i >= 0; i--) {
        messages.splice(toRemove[i], 1);
      }

      return json(res, { messages: result, count: result.length });
    }

    // ============================================================
    // Knowledge Endpoints — provenance-tracked, namespace-isolated
    // ============================================================

    // POST /api/knowledge — Store knowledge with full provenance
    if (method === 'POST' && path === '/api/knowledge' && !path.includes('/share') && !path.includes('/verify')) {
      const body = await readBody(req);
      const { content, project, agent, agentProject, host, source } = body;

      if (!content) return json(res, { error: 'content is required' }, 400);
      if (!project) return json(res, { error: 'project namespace is required' }, 400);

      const id = `kn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const item = {
        id,
        content,
        project,  // namespace — which project this knowledge belongs to
        createdBy: {
          agent: agent || null,
          project: agentProject || project,
          host: host || null
        },
        source: source || null,  // where the info came from (file, URL, user, etc.)
        timestamp: new Date().toISOString(),
        shared: false,
        sharedWith: [],
        verifications: []
        // verifications: [{ agent, project, verdict: 'confirmed'|'challenged', reason, timestamp }]
      };

      knowledge.set(id, item);
      markKnowledgeDirty();

      return json(res, { stored: true, id, project });
    }

    // GET /api/knowledge?project=X — Query knowledge for a project namespace
    if (method === 'GET' && path === '/api/knowledge') {
      const projectFilter = url.searchParams.get('project');
      const search = url.searchParams.get('search')?.toLowerCase();

      let items = [...knowledge.values()];

      // Filter by project namespace
      if (projectFilter) {
        items = items.filter(k =>
          k.project === projectFilter ||
          k.sharedWith.includes(projectFilter)
        );
      }

      // Simple text search
      if (search) {
        items = items.filter(k =>
          k.content.toLowerCase().includes(search)
        );
      }

      // Sort newest first
      items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Add verification summary to each item
      const results = items.map(k => ({
        ...k,
        verificationSummary: summarizeVerifications(k.verifications)
      }));

      return json(res, { knowledge: results, count: results.length });
    }

    // GET /api/knowledge/shared — Get all cross-project shared knowledge
    if (method === 'GET' && path === '/api/knowledge/shared') {
      const items = [...knowledge.values()]
        .filter(k => k.shared)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .map(k => ({
          ...k,
          verificationSummary: summarizeVerifications(k.verifications)
        }));

      return json(res, { knowledge: items, count: items.length });
    }

    // GET /api/knowledge/:id — Get single knowledge item with full provenance
    if (method === 'GET' && path.startsWith('/api/knowledge/') && !path.includes('/shared')) {
      const id = path.split('/').pop();
      const item = knowledge.get(id);
      if (!item) return json(res, { error: 'Knowledge item not found' }, 404);

      return json(res, {
        ...item,
        verificationSummary: summarizeVerifications(item.verifications)
      });
    }

    // POST /api/knowledge/:id/share — Share knowledge to another project
    if (method === 'POST' && path.match(/^\/api\/knowledge\/[^/]+\/share$/)) {
      const id = path.split('/')[3];
      const body = await readBody(req);
      const { targetProject } = body;

      if (!targetProject) return json(res, { error: 'targetProject is required' }, 400);

      const item = knowledge.get(id);
      if (!item) return json(res, { error: 'Knowledge item not found' }, 404);

      item.shared = true;
      if (!item.sharedWith.includes(targetProject)) {
        item.sharedWith.push(targetProject);
      }
      markKnowledgeDirty();

      return json(res, { shared: true, id, targetProject, sharedWith: item.sharedWith });
    }

    // POST /api/knowledge/:id/verify — Verify or challenge shared knowledge
    // Based on: Du et al. "Improving Factuality and Reasoning through Multiagent Debate" (MIT, ICLR 2025)
    if (method === 'POST' && path.match(/^\/api\/knowledge\/[^/]+\/verify$/)) {
      const id = path.split('/')[3];
      const body = await readBody(req);
      const { agent, project, verdict, reason } = body;

      if (!verdict || !['confirmed', 'challenged'].includes(verdict)) {
        return json(res, { error: 'verdict must be "confirmed" or "challenged"' }, 400);
      }

      const item = knowledge.get(id);
      if (!item) return json(res, { error: 'Knowledge item not found' }, 404);

      // Record the verification (each agent/project can verify once — update if exists)
      const existingIdx = item.verifications.findIndex(v =>
        v.agent === agent && v.project === project
      );
      const verification = {
        agent: agent || null,
        project: project || null,
        verdict,
        reason: reason || null,
        timestamp: new Date().toISOString()
      };

      if (existingIdx >= 0) {
        item.verifications[existingIdx] = verification;
      } else {
        item.verifications.push(verification);
      }
      markKnowledgeDirty();

      return json(res, {
        verified: true,
        id,
        verdict,
        verificationSummary: summarizeVerifications(item.verifications)
      });
    }

    // DELETE /api/knowledge/:id — delete a knowledge item
    if (method === 'DELETE' && path.match(/^\/api\/knowledge\/[^/]+$/) && !path.includes('/shared')) {
      const id = path.split('/').pop();
      if (!knowledge.has(id)) {
        return json(res, { error: 'Knowledge not found' }, 404);
      }
      knowledge.delete(id);
      markKnowledgeDirty();
      saveKnowledge();
      return json(res, { deleted: true, id });
    }

    // ============================================================
    // Task Delegation — "do this job and give me the result"
    // ============================================================

    // POST /api/tasks — Create a task for an agent to execute
    if (method === 'POST' && path === '/api/tasks') {
      const body = await readBody(req);
      const { from, fromName, to, toName, description, project, timeout } = body;

      if (!description) return json(res, { error: 'description is required' }, 400);
      if (!to && !toName) return json(res, { error: 'to or toName is required' }, 400);

      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const task = {
        id,
        from: from || null,
        fromName: fromName || null,
        to: to || null,
        toName: toName || null,
        project: project || null,
        description,
        status: 'pending',      // pending -> in_progress -> completed | failed | timeout
        result: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeout: timeout || 300000  // default 5 min
      };
      tasks.set(id, task);

      return json(res, { created: true, taskId: id });
    }

    // GET /api/tasks?agent=X&status=pending — Get tasks assigned to an agent
    if (method === 'GET' && path === '/api/tasks') {
      const agentFilter = url.searchParams.get('agent');
      const statusFilter = url.searchParams.get('status');

      let items = [...tasks.values()];
      if (agentFilter) {
        items = items.filter(t => t.to === agentFilter || t.toName === agentFilter);
      }
      if (statusFilter) {
        items = items.filter(t => t.status === statusFilter);
      }
      items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return json(res, { tasks: items, count: items.length });
    }

    // GET /api/tasks/:id — Get a single task (check status/result)
    if (method === 'GET' && path.match(/^\/api\/tasks\/[^/]+$/)) {
      const id = path.split('/').pop();
      const task = tasks.get(id);
      if (!task) return json(res, { error: 'Task not found' }, 404);
      return json(res, task);
    }

    // POST /api/tasks/:id/complete — Mark task done with result
    if (method === 'POST' && path.match(/^\/api\/tasks\/[^/]+\/complete$/)) {
      const id = path.split('/')[3];
      const body = await readBody(req);
      const { result, status } = body;

      const task = tasks.get(id);
      if (!task) return json(res, { error: 'Task not found' }, 404);

      task.status = status || 'completed';
      task.result = result || null;
      task.updatedAt = new Date().toISOString();

      return json(res, { updated: true, taskId: id, status: task.status });
    }

    // POST /api/tasks/fanout — Send the same task to multiple agents, collect all results
    if (method === 'POST' && path === '/api/tasks/fanout') {
      const body = await readBody(req);
      const { from, fromName, targets, description, project, timeout } = body;

      if (!description) return json(res, { error: 'description is required' }, 400);
      if (!targets || !Array.isArray(targets) || targets.length === 0) {
        return json(res, { error: 'targets array is required' }, 400);
      }

      const fanoutId = `fanout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const taskIds = [];

      for (const target of targets) {
        const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const task = {
          id,
          fanoutId,
          from: from || null,
          fromName: fromName || null,
          to: target.to || null,
          toName: target.toName || target || null,
          project: project || null,
          description,
          status: 'pending',
          result: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          timeout: timeout || 300000
        };
        tasks.set(id, task);
        taskIds.push(id);
      }

      return json(res, { created: true, fanoutId, taskIds, count: taskIds.length });
    }

    // GET /api/tasks/fanout/:fanoutId — Check status of all tasks in a fan-out
    if (method === 'GET' && path.match(/^\/api\/tasks\/fanout\/[^/]+$/)) {
      const fanoutId = path.split('/').pop();
      const fanoutTasks = [...tasks.values()].filter(t => t.fanoutId === fanoutId);
      if (fanoutTasks.length === 0) return json(res, { error: 'Fan-out not found' }, 404);

      const allDone = fanoutTasks.every(t => t.status === 'completed' || t.status === 'failed' || t.status === 'timeout');
      return json(res, {
        fanoutId,
        complete: allDone,
        tasks: fanoutTasks,
        summary: {
          total: fanoutTasks.length,
          completed: fanoutTasks.filter(t => t.status === 'completed').length,
          failed: fanoutTasks.filter(t => t.status === 'failed').length,
          pending: fanoutTasks.filter(t => t.status === 'pending').length,
          timeout: fanoutTasks.filter(t => t.status === 'timeout').length
        }
      });
    }

    // ============================================================
    // Skill Packages — agents declare what they can do
    // ============================================================

    // POST /api/skills — Register skills for an agent
    if (method === 'POST' && path === '/api/skills') {
      const body = await readBody(req);
      const { agent, agentSkills } = body;

      if (!agent) return json(res, { error: 'agent name is required' }, 400);
      if (!agentSkills || !Array.isArray(agentSkills)) return json(res, { error: 'agentSkills array is required' }, 400);

      skills.set(agent, agentSkills.map(s => ({
        name: s.name,
        description: s.description || '',
        inputSchema: s.inputSchema || null,
        project: s.project || null,
        agent
      })));

      return json(res, { registered: true, agent, count: agentSkills.length });
    }

    // GET /api/skills — List all registered skills across all agents
    if (method === 'GET' && path === '/api/skills') {
      const projectFilter = url.searchParams.get('project');
      const searchFilter = url.searchParams.get('search')?.toLowerCase();

      let allSkills = [];
      for (const [agent, agentSkills] of skills) {
        allSkills.push(...agentSkills);
      }

      if (projectFilter) {
        allSkills = allSkills.filter(s => s.project === projectFilter);
      }
      if (searchFilter) {
        allSkills = allSkills.filter(s =>
          s.name.toLowerCase().includes(searchFilter) ||
          s.description.toLowerCase().includes(searchFilter)
        );
      }

      return json(res, { skills: allSkills, count: allSkills.length });
    }

    // GET /api/skills/:agent — Get skills for a specific agent
    if (method === 'GET' && path.match(/^\/api\/skills\/[^/]+$/)) {
      const agent = decodeURIComponent(path.split('/').pop());
      const agentSkills = skills.get(agent) || [];
      return json(res, { agent, skills: agentSkills, count: agentSkills.length });
    }

    // ============================================================
    // Auto-Respond Controls
    // ============================================================

    // GET /api/auto-respond — get current stats and settings
    if (method === 'GET' && path === '/api/auto-respond') {
      resetDailyCountsIfNeeded();
      return json(res, {
        ...autoRespondStats,
        enabled: autoRespondEnabled,
        dailyLimit: autoRespondDailyLimit,
        model: 'haiku (via Cortex)',
        cortexUrl: CORTEX_URL
      });
    }

    // POST /api/auto-respond — toggle on/off, set daily limit
    if (method === 'POST' && path === '/api/auto-respond') {
      const body = await readBody(req);
      if (typeof body.enabled === 'boolean') {
        autoRespondEnabled = body.enabled;
        autoRespondStats.enabled = autoRespondEnabled;
        console.log(`[Auto-Respond] ${autoRespondEnabled ? 'ENABLED' : 'DISABLED'} by user`);
      }
      if (typeof body.dailyLimit === 'number' && body.dailyLimit >= 0) {
        autoRespondDailyLimit = body.dailyLimit;
        autoRespondStats.dailyLimit = autoRespondDailyLimit;
        console.log(`[Auto-Respond] Daily limit set to ${autoRespondDailyLimit}`);
      }
      saveAutoRespondStats();
      return json(res, {
        enabled: autoRespondEnabled,
        dailyLimit: autoRespondDailyLimit,
        todayResponses: autoRespondStats.todayResponses
      });
    }

    // DELETE /api/auto-respond/stats — reset all stats
    if (method === 'DELETE' && path === '/api/auto-respond/stats') {
      autoRespondStats.totalResponses = 0;
      autoRespondStats.totalTokensEstimated = 0;
      autoRespondStats.todayResponses = 0;
      autoRespondStats.todayTokensEstimated = 0;
      autoRespondStats.failedToday = 0;
      autoRespondStats.history = [];
      autoRespondStats.lastResponseAt = null;
      saveAutoRespondStats();
      return json(res, { reset: true });
    }

    // ============================================================
    // Alerts — cross-project notifications
    // ============================================================

    // POST /api/alerts — Create an alert
    if (method === 'POST' && path === '/api/alerts' && !path.includes('/resolve')) {
      const body = await readBody(req);
      const { content, severity, project, agent, affectsProjects } = body;
      if (!content) return json(res, { error: 'content is required' }, 400);

      // Deduplicate: skip if a similar active alert exists from same project in last 30 min
      const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
      for (const existing of alerts.values()) {
        if (!existing.resolved && existing.project === project &&
            new Date(existing.timestamp).getTime() > thirtyMinAgo &&
            existing.content.toLowerCase().includes(content.toLowerCase().slice(0, 50))) {
          return json(res, { stored: true, id: existing.id, deduplicated: true });
        }
      }

      const id = `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const alert = {
        id, content,
        severity: severity || 'warning',
        project: project || null,
        agent: agent || null,
        affectsProjects: affectsProjects || 'all',
        timestamp: new Date().toISOString(),
        resolved: false, resolvedAt: null, resolvedBy: null
      };
      alerts.set(id, alert);
      markAlertsDirty();
      saveAlerts();
      return json(res, { stored: true, id });
    }

    // GET /api/alerts?since=ISO&active=true
    if (method === 'GET' && path === '/api/alerts') {
      const since = url.searchParams.get('since');
      const activeOnly = url.searchParams.get('active') === 'true';
      const sinceTime = since ? new Date(since).getTime() : 0;

      let items = [...alerts.values()];
      if (sinceTime) items = items.filter(a => new Date(a.timestamp).getTime() > sinceTime);
      if (activeOnly) items = items.filter(a => !a.resolved);
      items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return json(res, { alerts: items, count: items.length });
    }

    // POST /api/alerts/:id/resolve
    if (method === 'POST' && path.match(/^\/api\/alerts\/[^/]+\/resolve$/)) {
      const id = path.split('/')[3];
      const body = await readBody(req);
      const alert = alerts.get(id);
      if (!alert) return json(res, { error: 'Alert not found' }, 404);
      alert.resolved = true;
      alert.resolvedAt = new Date().toISOString();
      alert.resolvedBy = body.agent || 'manual';
      markAlertsDirty();
      saveAlerts();
      return json(res, { resolved: true, id });
    }

    // ============================================================
    // Corrections — cross-project user feedback
    // ============================================================

    // POST /api/corrections
    if (method === 'POST' && path === '/api/corrections') {
      const body = await readBody(req);
      const { content, project, agent, source } = body;
      if (!content) return json(res, { error: 'content is required' }, 400);

      const id = `corr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const correction = {
        id, content,
        project: project || null,
        agent: agent || null,
        source: source || 'auto-detect',
        timestamp: new Date().toISOString()
      };
      corrections.set(id, correction);
      markCorrectionsDirty();
      saveCorrections();
      return json(res, { stored: true, id });
    }

    // GET /api/corrections?since=ISO
    if (method === 'GET' && path === '/api/corrections') {
      const since = url.searchParams.get('since');
      const sinceTime = since ? new Date(since).getTime() : 0;

      let items = [...corrections.values()];
      if (sinceTime) items = items.filter(c => new Date(c.timestamp).getTime() > sinceTime);
      items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return json(res, { corrections: items, count: items.length });
    }

    // DELETE /api/corrections/:id
    if (method === 'DELETE' && path.match(/^\/api\/corrections\/[^/]+$/)) {
      const id = path.split('/').pop();
      if (!corrections.has(id)) return json(res, { error: 'Correction not found' }, 404);
      corrections.delete(id);
      markCorrectionsDirty();
      saveCorrections();
      return json(res, { deleted: true, id });
    }

    // ============================================================
    // Activity Summary — cross-project daily catch-up
    // ============================================================

    // GET /api/activity?since=ISO&limit=N
    if (method === 'GET' && path === '/api/activity') {
      const since = url.searchParams.get('since');
      const limit = parseInt(url.searchParams.get('limit') || '10', 10);
      const sinceTime = since ? new Date(since).getTime() : Date.now() - 24 * 60 * 60 * 1000;

      const recentMessages = messageHistory
        .filter(m => new Date(m.timestamp).getTime() > sinceTime)
        .slice(-limit);

      const recentKnowledge = [...knowledge.values()]
        .filter(k => new Date(k.timestamp).getTime() > sinceTime)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, limit);

      const recentTasks = [...tasks.values()]
        .filter(t => new Date(t.createdAt).getTime() > sinceTime)
        .slice(0, limit);

      const activeAlerts = [...alerts.values()].filter(a => !a.resolved);
      const recentCorrections = [...corrections.values()]
        .filter(c => new Date(c.timestamp).getTime() > sinceTime);

      return json(res, {
        agents: getActiveAgents(),
        recentMessages,
        recentKnowledge,
        recentTasks,
        activeAlerts,
        recentCorrections,
        period: { since: new Date(sinceTime).toISOString(), until: new Date().toISOString() }
      });
    }

    // Health check
    if (method === 'GET' && (path === '/' || path === '/health')) {
      return json(res, {
        status: 'ok',
        agents: agents.size,
        messages: messages.length,
        messageHistory: messageHistory.length,
        knowledge: knowledge.size,
        alerts: [...alerts.values()].filter(a => !a.resolved).length,
        corrections: corrections.size,
        tasks: tasks.size,
        skills: [...skills.values()].reduce((sum, s) => sum + s.length, 0),
        uptime: process.uptime(),
        autoRespond: {
          enabled: autoRespondEnabled,
          todayResponses: autoRespondStats.todayResponses,
          dailyLimit: autoRespondDailyLimit
        }
      });
    }

    json(res, { error: 'Not found' }, 404);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Mevoric Hub] Listening on port ${PORT}`);
  console.log(`[Mevoric Hub] Agents: http://0.0.0.0:${PORT}/api/agents`);
  console.log(`[Mevoric Hub] Health: http://0.0.0.0:${PORT}/health`);
});
