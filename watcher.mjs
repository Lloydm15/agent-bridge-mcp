#!/usr/bin/env node

/**
 * Mevoric Notification Watcher
 *
 * Background heartbeat that polls for new agent messages every N seconds
 * and pops a Windows toast notification when one arrives.
 *
 * Zero API credits. Just reads files on a timer.
 *
 * Usage:
 *   node watcher.mjs              # default 5 second poll
 *   node watcher.mjs --interval 3 # 3 second poll
 *   node watcher.mjs --test       # send a test notification then exit
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { platform } from 'os';

// ── Config ──────────────────────────────────────────────

const DATA_DIR = process.env.MEVORIC_DATA_DIR
  || process.env.AGENT_BRIDGE_DATA_DIR
  || (platform() === 'win32'
    ? resolve(process.env.LOCALAPPDATA || '', 'agent-bridge')
    : resolve(process.env.HOME || '', '.local', 'share', 'mevoric'));

const MESSAGES_DIR = resolve(DATA_DIR, 'messages');
const CURSOR_FILE = resolve(DATA_DIR, 'watcher.cursor');

const args = process.argv.slice(2);
const intervalIdx = args.indexOf('--interval');
const POLL_MS = (intervalIdx !== -1 && args[intervalIdx + 1])
  ? parseInt(args[intervalIdx + 1], 10) * 1000
  : 5000;

// ── Cursor (tracks what we've already notified about) ───

function loadCursor() {
  try {
    return parseInt(readFileSync(CURSOR_FILE, 'utf8').trim(), 10) || Date.now();
  } catch {
    return Date.now();
  }
}

function saveCursor(ts) {
  try {
    writeFileSync(CURSOR_FILE, String(ts), 'utf8');
  } catch {}
}

// ── Popup Notification ───────────────────────────────────

function notify(title, body) {
  if (platform() !== 'win32') {
    console.log(`[NOTIFY] ${title}: ${body}`);
    return;
  }

  // WScript.Shell Popup — works on all Windows, bypasses DND, auto-closes after 5s
  const safeTitle = title.replace(/'/g, "''");
  const safeBody = body.replace(/'/g, "''");

  try {
    execSync(
      `powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).Popup('${safeBody}', 5, 'Mevoric: ${safeTitle}', 0x40)"`,
      { stdio: 'ignore', timeout: 8000 }
    );
  } catch {
    console.log(`[NOTIFY] ${title}: ${body}`);
  }
}

// ── Poll for new messages ───────────────────────────────

function checkMessages(lastTs) {
  let files;
  try {
    files = readdirSync(MESSAGES_DIR).filter(f => f.endsWith('.json')).sort();
  } catch {
    return { messages: [], highestTs: lastTs };
  }

  const newMessages = [];
  let highestTs = lastTs;

  for (const file of files) {
    const ts = parseInt(file.split('-')[0], 10);
    if (isNaN(ts) || ts <= lastTs) continue;

    try {
      const msg = JSON.parse(readFileSync(resolve(MESSAGES_DIR, file), 'utf8'));
      newMessages.push(msg);
      if (ts > highestTs) highestTs = ts;
    } catch {
      // malformed, skip
    }
  }

  return { messages: newMessages, highestTs };
}

// ── Test mode ───────────────────────────────────────────

if (args.includes('--test')) {
  console.log('Sending test notification...');
  notify('emergence-main-2', 'Hey Lloyd, I finished restoring the editor. PIE is ready.');
  setTimeout(() => process.exit(0), 3000);
} else {

// ── Main loop ───────────────────────────────────────────

let cursor = loadCursor();

console.log(`[Mevoric Watcher] Polling every ${POLL_MS / 1000}s`);
console.log(`[Mevoric Watcher] Messages dir: ${MESSAGES_DIR}`);
console.log(`[Mevoric Watcher] Cursor: ${new Date(cursor).toISOString()}`);

setInterval(() => {
  const { messages, highestTs } = checkMessages(cursor);

  if (messages.length > 0) {
    for (const msg of messages) {
      const from = msg.fromName || msg.from || 'unknown';
      const preview = (msg.content || '').slice(0, 120);
      const target = msg.broadcast ? 'broadcast' : `→ ${msg.toName || msg.to}`;

      console.log(`[${new Date().toLocaleTimeString()}] ${from} (${target}): ${preview}`);
      notify(`${from}`, preview);
    }

    cursor = highestTs;
    saveCursor(cursor);
  }
}, POLL_MS);

// Keep alive
process.on('SIGINT', () => {
  console.log('\n[Mevoric Watcher] Stopped.');
  process.exit(0);
});

} // end else (not --test)
