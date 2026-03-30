#!/usr/bin/env node

/**
 * Mevoric Agent Runner
 *
 * Background daemon that polls the hub for direct messages addressed to
 * local agents.  When a message arrives, it spins up a Claude CLI call
 * to generate a response and sends the reply back through the hub.
 *
 * Agents finally talk to each other for real.
 *
 * Usage:
 *   node runner.mjs                     # default 10s poll
 *   node runner.mjs --interval 5        # 5s poll
 *   node runner.mjs --dry-run           # poll + log but don't call Claude
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { platform } from 'os';

// ── Config ──────────────────────────────────────────────

const HUB_URL = process.env.MEVORIC_HUB_URL
  || process.env.AGENT_BRIDGE_HUB_URL
  || 'http://192.168.2.100:4100';

const DATA_DIR = process.env.MEVORIC_DATA_DIR
  || process.env.AGENT_BRIDGE_DATA_DIR
  || (platform() === 'win32'
    ? resolve(process.env.LOCALAPPDATA || '', 'agent-bridge')
    : resolve(process.env.HOME || '', '.local', 'share', 'mevoric'));

const AGENTS_DIR = resolve(DATA_DIR, 'agents');
const CURSOR_FILE = resolve(DATA_DIR, 'runner.cursor');

const args = process.argv.slice(2);
const intervalIdx = args.indexOf('--interval');
const POLL_MS = (intervalIdx !== -1 && args[intervalIdx + 1])
  ? parseInt(args[intervalIdx + 1], 10) * 1000
  : 10000;

const DRY_RUN = args.includes('--dry-run');

// Max concurrent calls at once (bumped for parallel execution)
const MAX_CONCURRENT = parseInt(process.env.MEVORIC_MAX_CONCURRENT || '3', 10);
let activeCalls = 0;

// Track which messages we already processed (avoid double-replies)
const processedMessages = new Set();

// Track conversation chains to prevent infinite loops (max 3 back-and-forth)
const conversationDepth = new Map(); // "agentA<->agentB" => count

// ── Cursor ──────────────────────────────────────────────

function loadCursor() {
  try {
    return readFileSync(CURSOR_FILE, 'utf8').trim();
  } catch {
    // First run — start from now so we don't replay old messages
    return new Date().toISOString();
  }
}

function saveCursor(ts) {
  try {
    writeFileSync(CURSOR_FILE, ts, 'utf8');
  } catch {}
}

// ── Local agents (who are we responsible for?) ──────────

function getLocalAgents() {
  try {
    const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'));
    const agents = [];
    for (const file of files) {
      try {
        const agent = JSON.parse(readFileSync(resolve(AGENTS_DIR, file), 'utf8'));
        if (agent.name) agents.push(agent);
      } catch {}
    }
    return agents;
  } catch {
    return [];
  }
}

// ── Hub API ─────────────────────────────────────────────

async function hubFetch(path, opts = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${HUB_URL}${path}`, {
      ...opts,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...opts.headers }
    });
    clearTimeout(timer);
    return await res.json();
  } catch (err) {
    console.error(`[Hub] ${path} failed: ${err.message}`);
    return null;
  }
}

async function getMessageLog() {
  return hubFetch('/api/messages/log?limit=50');
}

async function sendReply(from, to, content) {
  return hubFetch('/api/messages', {
    method: 'POST',
    body: JSON.stringify({
      from,
      fromName: from,
      to,
      toName: to,
      content
    })
  });
}

// ── Ollama LLM call (local, free) ───────────────────────

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://192.168.2.169:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b';

// ── Cortex API (real knowledge retrieval + storage) ────

const CORTEX_URL = process.env.CORTEX_URL || 'http://192.168.2.100:3100';

async function askCortex(queryText, limit = 5) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${CORTEX_URL}/api/retrieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: queryText, limit }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.memories || []).filter(m => m.score > 0.6);
  } catch {
    return [];
  }
}

async function storeToCortex(content, title, agent, project) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    await fetch(`${CORTEX_URL}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, title, agent, project }),
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch {}
}

async function callClaude(agentName, project, cwd, messageContent, senderName) {
  // Ask Cortex what we actually know about this topic
  const cortexMemories = await askCortex(messageContent, 5);
  const knowledgeContext = cortexMemories.length > 0
    ? `\n\nREAL FACTS from Cortex (use these to answer accurately):\n${cortexMemories.map((m, i) => `${i + 1}. ${m.memory.slice(0, 300)}`).join('\n')}`
    : '';

  const systemPrompt = [
    `You are ${agentName}, working on ${project}.`,
    `${senderName} sent you a message.`,
    `STRICT RULES:`,
    `1. ONLY use facts from the REAL FACTS section below. Nothing else.`,
    `2. If there are NO real facts below, or the facts don't answer their question, say EXACTLY: "I don't have info on that."`,
    `3. NEVER invent details, suggest things not in the facts, or speculate.`,
    `4. NEVER say "you're welcome", "glad to help", or offer to collaborate on things not in the facts.`,
    `5. Keep it to 1-2 sentences. Plain text only. No markdown. No thinking tags.`,
    `6. If they're just being polite (thanks, welcome, etc), say "Got it." and nothing else.`
  ].join(' ');

  return callOllama(systemPrompt, `Message from ${senderName}: "${messageContent}"${knowledgeContext}\n\nReply to them:`);
}

// ── Main polling loop ───────────────────────────────────

let cursor = loadCursor();

console.log(`[Mevoric Runner] Started — polling every ${POLL_MS / 1000}s`);
console.log(`[Mevoric Runner] Hub: ${HUB_URL}`);
console.log(`[Mevoric Runner] Cursor: ${cursor}`);
if (DRY_RUN) console.log(`[Mevoric Runner] DRY RUN — will not call Claude or send replies`);

async function poll() {
  // Get local agents we're responsible for
  const localAgents = getLocalAgents();
  if (localAgents.length === 0) return;

  const agentNames = new Set(localAgents.map(a => a.name));

  // Fetch recent messages from hub
  const data = await getMessageLog();
  if (!data || !data.messages) return;

  // Find direct messages TO our agents that are newer than cursor
  const cursorDate = new Date(cursor);
  const incoming = data.messages.filter(msg => {
    // Skip broadcasts — those are session summaries, not conversations
    if (msg.broadcast) return false;
    // Skip messages we already processed
    if (processedMessages.has(msg.id)) return false;
    // Must be addressed to one of our local agents
    const toName = msg.toName || msg.to;
    if (!agentNames.has(toName)) return false;
    // Must be newer than our cursor
    if (new Date(msg.timestamp) <= cursorDate) return false;
    // Allow replies between our own agents (proactive conversations)
    const fromName = msg.fromName || msg.from;
    return true;
  });

  if (incoming.length === 0) return;

  console.log(`[${new Date().toLocaleTimeString()}] ${incoming.length} new message(s) to process`);

  for (const msg of incoming) {
    // Rate limit
    if (activeCalls >= MAX_CONCURRENT) {
      console.log(`[Runner] At max concurrent (${MAX_CONCURRENT}), deferring...`);
      break;
    }

    const toName = msg.toName || msg.to;
    const fromName = msg.fromName || msg.from;
    const agent = localAgents.find(a => a.name === toName);
    const content = msg.content || '';

    console.log(`[${new Date().toLocaleTimeString()}] ${fromName} → ${toName}: ${content.slice(0, 80)}`);

    // Skip auto-replies between agents in the same project — those are manual only
    const senderAgent = localAgents.find(a => a.name === fromName);
    if (senderAgent && senderAgent.project === agent?.project) {
      console.log(`[Runner] Same project (${agent?.project}), skipping auto-reply — manual only`);
      continue;
    }

    // Check conversation depth to prevent infinite loops
    const pairKey = [fromName, toName].sort().join('<->');
    const depth = conversationDepth.get(pairKey) || 0;
    if (depth >= 1) {
      console.log(`[Runner] Conversation ${pairKey} at depth ${depth}, one exchange max`);
      processedMessages.add(msg.id);
      continue;
    }
    conversationDepth.set(pairKey, depth + 1);
    // Reset depth after 10 minutes
    setTimeout(() => conversationDepth.delete(pairKey), 10 * 60 * 1000);

    // Mark as processed immediately to avoid double-processing
    processedMessages.add(msg.id);

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would call Claude as ${toName} and reply to ${fromName}`);
      continue;
    }

    activeCalls++;

    // Fire off Claude call (don't await — let multiple run)
    (async () => {
      try {
        const agentProject = agent?.project || 'unknown';
        const reply = await callClaude(
          toName,
          agentProject,
          agent?.cwd || process.cwd(),
          content,
          fromName
        );

        if (reply) {
          console.log(`[${new Date().toLocaleTimeString()}] ${toName} replies to ${fromName}: ${reply.slice(0, 80)}`);
          await sendReply(toName, fromName, reply);

          // Only store to Cortex if the reply has real info (not "I don't know" or pleasantries)
          const useless = /^(i don't have info|got it\.|you're welcome|thanks|acknowledged)/i;
          if (!useless.test(reply.trim())) {
            const exchangeSummary = `${fromName} asked: ${content.slice(0, 200)}\n${toName} answered: ${reply.slice(0, 300)}`;
            await storeToCortex(
              exchangeSummary,
              `${fromName} ↔ ${toName}: ${content.slice(0, 60)}`,
              toName,
              agentProject
            );
          }
        }
      } catch (err) {
        console.error(`[Runner] Error processing message: ${err.message}`);
      } finally {
        activeCalls--;
      }
    })();
  }

  // Update cursor to the newest message timestamp
  const newest = incoming.reduce((latest, msg) =>
    new Date(msg.timestamp) > new Date(latest) ? msg.timestamp : latest,
    cursor
  );
  cursor = newest;
  saveCursor(cursor);

  // Keep processedMessages from growing forever
  if (processedMessages.size > 500) {
    const arr = [...processedMessages];
    processedMessages.clear();
    arr.slice(-200).forEach(id => processedMessages.add(id));
  }
}

// ── Task execution — agents do jobs and return results ──

async function pollTasks() {
  const localAgents = getLocalAgents();
  if (localAgents.length === 0) return;

  for (const agent of localAgents) {
    if (activeCalls >= MAX_CONCURRENT) break;

    // Fetch pending tasks for this agent
    const data = await hubFetch(`/api/tasks?agent=${encodeURIComponent(agent.name)}&status=pending`);
    if (!data || !data.tasks || data.tasks.length === 0) continue;

    for (const task of data.tasks) {
      if (activeCalls >= MAX_CONCURRENT) break;

      console.log(`[${new Date().toLocaleTimeString()}] [TASK] ${agent.name} executing: ${task.description.slice(0, 80)}`);

      if (DRY_RUN) {
        console.log(`[DRY RUN] Would execute task ${task.id} as ${agent.name}`);
        continue;
      }

      activeCalls++;

      (async () => {
        try {
          const reply = await callClaude(
            agent.name,
            agent.project || 'unknown',
            agent.cwd || process.cwd(),
            task.description,
            task.fromName || 'system'
          );

          // Report result back to hub
          await hubFetch(`/api/tasks/${task.id}/complete`, {
            method: 'POST',
            body: JSON.stringify({
              result: reply || 'No response generated',
              status: reply ? 'completed' : 'failed'
            })
          });

          console.log(`[${new Date().toLocaleTimeString()}] [TASK] ${task.id} ${reply ? 'completed' : 'failed'}`);
        } catch (err) {
          console.error(`[Runner] Task error: ${err.message}`);
          await hubFetch(`/api/tasks/${task.id}/complete`, {
            method: 'POST',
            body: JSON.stringify({ result: err.message, status: 'failed' })
          });
        } finally {
          activeCalls--;
        }
      })();
    }
  }
}

// ── Proactive conversation — agents ask each other questions ──

const CONVO_INTERVAL_MS = process.env.CONVO_INTERVAL ? parseInt(process.env.CONVO_INTERVAL) * 1000 : 5 * 60 * 1000;
const askedRecently = new Set(); // Track agent pairs to avoid spam

// No more hub knowledge — Cortex is the only knowledge store.
// startConversation() queries Cortex directly per project.

async function startConversation() {
  console.log(`[Convo] Starting conversation check...`);
  if (activeCalls >= MAX_CONCURRENT || DRY_RUN) { console.log(`[Convo] Skipped: active=${activeCalls} dry=${DRY_RUN}`); return; }

  const localAgents = getLocalAgents();
  console.log(`[Convo] Local agents: ${localAgents.length}`);
  if (localAgents.length < 2) { console.log(`[Convo] Skipped: need 2+ agents`); return; }

  // Group agents by project
  const byProject = {};
  for (const agent of localAgents) {
    const p = agent.project || 'unknown';
    if (!byProject[p]) byProject[p] = [];
    byProject[p].push(agent);
  }

  // Filter out non-project agents (Abyss = no-project tab, unknown = unregistered)
  const NON_PROJECTS = new Set(['Abyss', 'abyss', 'unknown']);
  const projects = Object.keys(byProject).filter(p => !NON_PROJECTS.has(p));
  console.log(`[Convo] Projects: ${projects.join(', ')}`);
  if (projects.length < 2) { console.log(`[Convo] Skipped: need 2+ projects`); return; }

  // Pick a random agent from one project to ask a question to an agent in another project
  const proj1 = projects[Math.floor(Math.random() * projects.length)];
  let proj2 = projects[Math.floor(Math.random() * projects.length)];
  let tries = 0;
  while (proj2 === proj1 && tries < 10) {
    proj2 = projects[Math.floor(Math.random() * projects.length)];
    tries++;
  }
  if (proj2 === proj1) return;

  const asker = byProject[proj1][Math.floor(Math.random() * byProject[proj1].length)];
  const target = byProject[proj2][Math.floor(Math.random() * byProject[proj2].length)];

  const pairKey = `${asker.name}->${target.name}`;
  if (askedRecently.has(pairKey)) return;

  // Ask Cortex for real context about both projects
  const cortexAboutTarget = await askCortex(`${target.project} project recent work`, 3);
  const cortexAboutAsker = await askCortex(`${asker.project} project recent work`, 3);

  const realTargetContext = cortexAboutTarget.length > 0
    ? cortexAboutTarget.map(m => m.memory.slice(0, 200)).join('\n')
    : '';
  const realAskerContext = cortexAboutAsker.length > 0
    ? cortexAboutAsker.map(m => m.memory.slice(0, 200)).join('\n')
    : '';

  // Don't start conversations unless Cortex has REAL relevant info about BOTH projects
  if (!realTargetContext || !realAskerContext) {
    console.log(`[Convo] Skipped: Cortex doesn't have real info about both projects`);
    return;
  }

  // Generate a question using Ollama
  const systemPrompt = [
    `You are ${asker.name}, working on ${asker.project}.`,
    `${target.name} works on ${target.project}.`,
    `Ask them ONE question based ONLY on the real facts below.`,
    `STRICT RULES:`,
    `1. Your question MUST reference something SPECIFIC from the facts — a real file, tool, error, or task mentioned below.`,
    `2. NEVER ask about things not in the facts. NEVER invent topics.`,
    `3. NEVER ask vague questions like "how's it going" or "any challenges".`,
    `4. 1 sentence. Plain text only. No markdown. No thinking tags.`
  ].join(' ');

  const context = [];
  context.push(`REAL FACTS about your project (${asker.project}):\n${realAskerContext}`);
  context.push(`REAL FACTS about ${target.name}'s project (${target.project}):\n${realTargetContext}`);
  context.push(`Ask ${target.name} a specific question:`);

  activeCalls++;
  try {
    const question = await callOllama(systemPrompt, context.join('\n\n'));
    if (question) {
      console.log(`[${new Date().toLocaleTimeString()}] [CONVO] ${asker.name} asks ${target.name}: ${question.slice(0, 100)}`);
      await sendReply(asker.name, target.name, question);
      askedRecently.add(pairKey);
      // Clear pair after 15 minutes so they can talk again
      setTimeout(() => askedRecently.delete(pairKey), 15 * 60 * 1000);
    }
  } catch (err) {
    console.error(`[Convo] Error: ${err.message}`);
  } finally {
    activeCalls--;
  }
}

// Generic Ollama call (used by both reply and convo)
async function callOllama(systemPrompt, userMessage) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timer);
    if (!res.ok) return null;

    const data = await res.json();
    let reply = data.message?.content?.trim();
    if (reply) reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return reply || null;
  } catch {
    return null;
  }
}

// Start polling for messages and tasks
setInterval(poll, POLL_MS);
setInterval(pollTasks, POLL_MS);
poll();
pollTasks();

// Start proactive conversations — use sequential scheduling to prevent overlap
console.log(`[Mevoric Runner] Proactive conversations every ${CONVO_INTERVAL_MS / 1000}s`);

async function convoLoop() {
  await startConversation();
  setTimeout(convoLoop, CONVO_INTERVAL_MS);
}
setTimeout(convoLoop, 15000); // First one after 15s

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Mevoric Runner] Stopped.');
  saveCursor(cursor);
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveCursor(cursor);
  process.exit(0);
});
