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
import { spawn } from 'child_process';

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

// ── Agent SDK (real Claude Code sessions with tools) ────

let _sdkQuery = null;

async function getSDKQuery() {
  if (_sdkQuery) return _sdkQuery;
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _sdkQuery = sdk.query;
    return _sdkQuery;
  } catch (err) {
    console.error(`[SDK] Failed to load Agent SDK: ${err.message}`);
    return null;
  }
}

// Project directory map — where each project lives per platform
const IS_WINDOWS = platform() === 'win32';

const PROJECT_DIRS_WIN = {
  'Cortex':         'c:\\dev\\Cortex',
  'Abyss':          'c:\\dev\\Abyss',
  'Mevoric':        'c:\\dev\\Mevoric',
  'WeFixPodcasts':  'c:\\dev\\WeFixPodcasts',
  'NovaStreamLive': 'c:\\dev\\NovaStreamLive',
  'Clonebot':       'c:\\dev\\Clonebot',
  'Emergence':      'c:\\dev\\Emergence',
};

const PROJECT_DIRS_LINUX = {
  'Cortex':         '/home/toptiercrm/Cortex',
  'Emergence':      '/home/toptiercrm/emergence',
  'Mevoric':        '/home/toptiercrm/mevoric-repo',
  'Clonebot':       '/home/toptiercrm/clonebot',
};

// Case-insensitive lookup
function lookupProjectDir(name) {
  const dirs = IS_WINDOWS ? PROJECT_DIRS_WIN : PROJECT_DIRS_LINUX;
  // Try exact match first
  if (dirs[name]) return dirs[name];
  // Try case-insensitive
  const key = Object.keys(dirs).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? dirs[key] : null;
}

function resolveProjectDir(agent) {
  // Use agent's registered cwd if it's a real path (not just a fallback)
  if (agent.cwd && agent.cwd !== process.cwd()) {
    // Accept any absolute path — Windows (c:\...) or Linux (/home/...)
    if (agent.cwd.match(/^[a-zA-Z]:\\/) || agent.cwd.startsWith('/')) return agent.cwd;
  }
  // Fall back to platform-specific project map
  return lookupProjectDir(agent.project) || lookupProjectDir(agent.baseName) || process.cwd();
}

// Read-only tools — safe for "just look stuff up" tasks
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch'];

/**
 * Execute a task using a real Claude Code session with full tool access.
 * This is the "Limitless" upgrade — agents actually DO work, not just talk about it.
 *
 * @param {object} agent - The local agent handling the task
 * @param {object} task  - The task from the hub { description, mode, fromName, project }
 * @returns {string|null} The result text
 */
async function executeTaskWithSDK(agent, task) {
  const query = await getSDKQuery();
  if (!query) {
    console.error(`[SDK] Agent SDK not available, falling back to Ollama`);
    return callClaude(agent.name, agent.project || 'unknown', agent.cwd || process.cwd(), task.description, task.fromName || 'system');
  }

  const cwd = resolveProjectDir(agent);
  const mode = task.mode || 'full';  // 'readonly' or 'full'
  const maxTurns = task.maxTurns || (mode === 'readonly' ? 5 : 15);
  const timeoutMs = task.timeout || (mode === 'readonly' ? 60000 : 300000);

  const systemPrompt = [
    `You are ${agent.name}, working on ${agent.project || 'unknown'}.`,
    `${task.fromName || 'Another agent'} delegated this task to you through Mevoric.`,
    `You have full access to the project at ${cwd}.`,
    mode === 'readonly'
      ? `This is a READ-ONLY task. Only look things up and report back. Do NOT edit, create, or delete any files.`
      : `You may read, edit, create files, and run commands to complete this task.`,
    `When done, give a clear, concise summary of what you found or did. Plain text, no markdown.`,
    `Do NOT ask questions — just do the work and report the result.`
  ].join(' ');

  const options = {
    maxTurns,
    cwd,
    systemPrompt,
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    env: getCleanEnv(),
  };

  // Restrict tools for read-only mode
  if (mode === 'readonly') {
    options.tools = READ_ONLY_TOOLS;
  }

  console.log(`[SDK] Executing task for ${agent.name} | mode=${mode} | maxTurns=${maxTurns} | cwd=${cwd}`);

  let fullText = '';
  const deadline = Date.now() + timeoutMs;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    for await (const ev of query({ prompt: task.description, options, signal: controller.signal })) {
      if (Date.now() > deadline) {
        console.log(`[SDK] Task timed out after ${timeoutMs / 1000}s`);
        controller.abort();
        break;
      }

      // Collect text output
      if (ev?.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) fullText += block.text;
        }
      }
      if (ev?.type === 'result' && ev.text) fullText = ev.text;
    }

    clearTimeout(timer);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log(`[SDK] Task aborted (timeout)`);
    } else {
      console.error(`[SDK] Task failed: ${err.message}`);
      throw err;
    }
  }

  return fullText.trim() || null;
}

function getCleanEnv() {
  const env = { ...process.env };
  // Remove vars that would confuse a nested Claude Code session
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;
  return env;
}

// ── Ollama LLM call (local, free — still used for messages) ──

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
    `RULES:`,
    `1. If there are REAL FACTS below, use them to answer accurately.`,
    `2. If there are no facts, answer based on what you reasonably know about ${project} as a project. Be honest about what you're unsure of.`,
    `3. NEVER invent specific details like file names, line numbers, or config values you don't know.`,
    `4. Keep it to 1-3 sentences. Plain text only. No markdown. No thinking tags.`,
    `5. If they're just being polite (thanks, welcome, etc), say "Got it." and nothing else.`
  ].join(' ');

  const fullPrompt = `${systemPrompt}\n\nMessage from ${senderName}: "${messageContent}"${knowledgeContext}\n\nReply to them:`;

  // Smart routing: complex stuff goes to Claude (via Cortex), simple stuff to Ollama
  if (shouldUseClaude(messageContent)) {
    console.log(`[Router] Using Claude (via Cortex) — message is complex`);
    const claudeReply = await callCortexChat(fullPrompt);
    if (claudeReply) return claudeReply;
    // Fall back to Ollama if Cortex fails
    console.log(`[Router] Cortex failed, falling back to Ollama`);
  } else {
    console.log(`[Router] Using Ollama — message is simple`);
  }

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

// ── PC Sleep Signal — listen for "sleep-now" from Cortex after overnight learning ──

const processedSleepSignals = new Set();
const PC_CONTROLLER_NAME = 'pc-controller';

// Only run sleep signals on Windows PCs — skip on Linux server
const IS_PC = platform() === 'win32';

async function pollSleepSignals() {
  if (!IS_PC) return;  // Server never sleeps from this signal

  const data = await getMessageLog();
  if (!data || !data.messages) return;

  const cursorDate = new Date(cursor);
  const sleepMessages = data.messages.filter(msg => {
    if (msg.broadcast) return false;
    if (processedSleepSignals.has(msg.id)) return false;
    const toName = msg.toName || msg.to;
    if (toName !== PC_CONTROLLER_NAME) return false;
    if (msg.content?.trim() !== 'sleep-now') return false;
    // Only honor messages newer than the runner start cursor
    if (new Date(msg.timestamp) <= cursorDate) return false;
    return true;
  });

  for (const msg of sleepMessages) {
    processedSleepSignals.add(msg.id);
    const fromName = msg.fromName || msg.from;
    console.log(`[${new Date().toLocaleTimeString()}] [SLEEP] Received sleep-now from ${fromName}`);

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would put PC to sleep now`);
      continue;
    }

    // Give the console log time to flush, then run the Windows sleep command
    setTimeout(() => {
      try {
        console.log(`[SLEEP] Running rundll32.exe powrprof.dll,SetSuspendState 0,1,0`);
        spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0', '1', '0'], {
          detached: true,
          stdio: 'ignore'
        }).unref();
      } catch (err) {
        console.error(`[SLEEP] Failed to trigger sleep: ${err.message}`);
      }
    }, 2000);
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
          // Use real Claude Code session (Agent SDK) for tasks
          const reply = await executeTaskWithSDK(agent, task);

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

// ── Cortex Quick Reply (lightweight — no memory retrieval, no feedback) ──

async function callCortexChat(prompt) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    // Use /api/quick-reply instead of /api/chat to avoid triggering
    // memory retrieval and feedback — agent-to-agent messages were
    // accidentally damaging memory confidence scores
    const res = await fetch(`${CORTEX_URL}/api/quick-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: '', userMessage: prompt }),
      signal: controller.signal
    });

    clearTimeout(timer);
    if (!res.ok) return null;

    const data = await res.json();
    return data.reply?.trim() || null;
  } catch (err) {
    console.error(`[CortexChat] Error: ${err.message}`);
    return null;
  }
}

// ── Smart routing — decide Ollama vs Claude ────────────

const COMPLEX_WORDS = /\b(analyze|analyse|compare|explain|build|design|review|debug|refactor|implement|architecture|strategy|evaluate|optimize|plan|migrate|integrate)\b/i;

function shouldUseClaude(messageContent) {
  if (!messageContent) return false;
  // Long messages → Claude
  if (messageContent.length > 200) return true;
  // Complex keywords → Claude
  if (COMPLEX_WORDS.test(messageContent)) return true;
  return false;
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

// Start polling for messages, tasks, and PC sleep signals
setInterval(poll, POLL_MS);
setInterval(pollTasks, POLL_MS);
setInterval(pollSleepSignals, POLL_MS);
poll();
pollTasks();
pollSleepSignals();

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
