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
const STALE_MS = 15000;   // 15s without heartbeat = stale
const DEAD_MS = 300000;   // 5min without heartbeat = dead, auto-removed
const MSG_TTL_MS = 3600000; // 1 hour message expiry
const KNOWLEDGE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days knowledge expiry

// Persistence directory (same dir as hub.mjs)
const __dirname = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_FILE = resolve(__dirname, 'knowledge.json');

// ============================================================
// In-memory stores
// ============================================================

const agents = new Map();   // agentId -> { id, name, baseName, project, cwd, pid, host, startedAt, lastHeartbeat }
const messages = [];        // [{ id, from, fromName, to, toName, broadcast, content, project, timestamp }]

// Knowledge store — per-project namespaces with provenance and verification
// Design: Memori namespaces (GibsonAI) + Collaborative Memory provenance (arXiv:2505.18279)
const knowledge = new Map(); // knowledgeId -> { id, content, project, createdBy:{agent,project,host}, source, timestamp, shared, sharedWith[], verifications[] }

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
      status: age > STALE_MS ? 'stale' : 'active'
    });
  }
  return result;
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
      return json(res, { sent: true, messageId: msg.id });
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

    // Health check
    if (method === 'GET' && (path === '/' || path === '/health')) {
      return json(res, {
        status: 'ok',
        agents: agents.size,
        messages: messages.length,
        knowledge: knowledge.size,
        uptime: process.uptime()
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
