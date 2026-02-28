#!/usr/bin/env node

/**
 * npx mevoric init
 *
 * Sets up Mevoric for Claude Code. Handles everything:
 * 1. Writes global ~/.claude/.mcp.json entry
 * 2. Finds and updates ALL project-level .mcp.json files that have old agent-bridge or newcode-memory entries
 * 3. Updates ~/.claude/settings.json hooks and permissions
 * 4. Removes old pip packages (newcode-memory, agent-bridge-mcp) that auto-register as duplicate MCP servers
 * 5. Migrates existing data (agent-bridge data dir) so nothing is lost
 */

import {
  existsSync, readFileSync, writeFileSync, readdirSync,
  mkdirSync, statSync
} from 'fs';
import { resolve, dirname } from 'path';
import { homedir, platform } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = resolve(__dirname, 'server.mjs');

// ============================================================
// Paths
// ============================================================

const CLAUDE_DIR = resolve(homedir(), '.claude');
const GLOBAL_MCP = resolve(CLAUDE_DIR, '.mcp.json');
const SETTINGS = resolve(CLAUDE_DIR, 'settings.json');

function getDefaultDataDir() {
  const p = platform();
  if (p === 'win32') return resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'mevoric');
  if (p === 'darwin') return resolve(homedir(), 'Library', 'Application Support', 'mevoric');
  return resolve(process.env.XDG_DATA_HOME || resolve(homedir(), '.local', 'share'), 'mevoric');
}

function getLegacyDataDir() {
  const p = platform();
  if (p === 'win32') return resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'agent-bridge');
  if (p === 'darwin') return resolve(homedir(), 'Library', 'Application Support', 'agent-bridge');
  return resolve(process.env.XDG_DATA_HOME || resolve(homedir(), '.local', 'share'), 'agent-bridge');
}

// ============================================================
// Helpers
// ============================================================

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function log(msg) {
  console.log(`  ${msg}`);
}

function logHeader(msg) {
  console.log(`\n${msg}`);
}

// ============================================================
// Step 1: Global .mcp.json
// ============================================================

function updateGlobalMcp(serverUrl) {
  logHeader('1. Global MCP config (~/.claude/.mcp.json)');

  const existing = readJSON(GLOBAL_MCP) || { mcpServers: {} };
  if (!existing.mcpServers) existing.mcpServers = {};

  // Remove old entries
  let removedOld = false;
  if (existing.mcpServers['agent-bridge']) {
    delete existing.mcpServers['agent-bridge'];
    log('Removed old agent-bridge entry');
    removedOld = true;
  }
  if (existing.mcpServers['newcode-memory']) {
    delete existing.mcpServers['newcode-memory'];
    log('Removed old newcode-memory entry');
    removedOld = true;
  }

  // Determine data dir — use legacy dir if it exists (preserve existing data)
  const legacyDir = getLegacyDataDir();
  const dataDir = existsSync(legacyDir) ? legacyDir : getDefaultDataDir();

  // Add mevoric entry
  const env = {};
  if (serverUrl) env.MEVORIC_SERVER_URL = serverUrl;
  if (dataDir !== getDefaultDataDir()) env.MEVORIC_DATA_DIR = dataDir;

  existing.mcpServers['mevoric'] = {
    type: 'stdio',
    command: 'node',
    args: [SERVER_PATH],
    ...(Object.keys(env).length > 0 ? { env } : {})
  };

  writeJSON(GLOBAL_MCP, existing);
  log(existing.mcpServers['mevoric'] ? 'Updated mevoric entry' : 'Added mevoric entry');
  if (dataDir !== getDefaultDataDir()) log(`Using legacy data dir: ${dataDir}`);

  return dataDir;
}

// ============================================================
// Step 2: Find and update project-level .mcp.json files
// ============================================================

function findProjectMcpFiles() {
  const dirs = [];

  // Check settings.json for additionalDirectories
  const settings = readJSON(SETTINGS);
  if (settings?.permissions?.additionalDirectories) {
    dirs.push(...settings.permissions.additionalDirectories);
  }

  // Also check common dev directories
  const devDirs = [
    resolve(homedir(), 'dev'),
    resolve(homedir(), 'projects'),
    resolve(homedir(), 'code'),
    resolve(homedir(), 'src'),
  ];
  // Windows: also check C:\dev
  if (platform() === 'win32') {
    devDirs.push('C:\\dev');
    devDirs.push('D:\\dev');
  }

  for (const dir of devDirs) {
    if (existsSync(dir)) {
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const full = resolve(dir, entry);
          try {
            if (statSync(full).isDirectory()) dirs.push(full);
          } catch {}
        }
      } catch {}
    }
  }

  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const d of dirs) {
    const norm = d.toLowerCase().replace(/\\/g, '/');
    if (!seen.has(norm)) {
      seen.add(norm);
      unique.push(d);
    }
  }

  // Check each for .mcp.json with old entries
  const results = [];
  for (const dir of unique) {
    const mcpPath = resolve(dir, '.mcp.json');
    if (!existsSync(mcpPath)) continue;

    const mcp = readJSON(mcpPath);
    if (!mcp?.mcpServers) continue;

    const hasOld = mcp.mcpServers['agent-bridge'] || mcp.mcpServers['newcode-memory'];
    if (hasOld) {
      results.push({ path: mcpPath, dir, mcp });
    }
  }

  return results;
}

function updateProjectMcpFiles(serverUrl, dataDir) {
  logHeader('2. Project-level .mcp.json files');

  const files = findProjectMcpFiles();
  if (files.length === 0) {
    log('No project-level files with old entries found');
    return;
  }

  for (const { path, dir, mcp } of files) {
    // Extract agent name from old entry
    const oldBridge = mcp.mcpServers['agent-bridge'];
    const oldMemory = mcp.mcpServers['newcode-memory'];
    const agentName = oldBridge?.env?.AGENT_BRIDGE_NAME
      || oldBridge?.env?.MEVORIC_AGENT_NAME
      || null;

    // Remove old entries
    delete mcp.mcpServers['agent-bridge'];
    delete mcp.mcpServers['newcode-memory'];

    // Add mevoric entry
    const env = {};
    if (agentName) env.MEVORIC_AGENT_NAME = agentName;
    if (serverUrl) env.MEVORIC_SERVER_URL = serverUrl;
    if (dataDir && dataDir !== getDefaultDataDir()) env.MEVORIC_DATA_DIR = dataDir;

    mcp.mcpServers['mevoric'] = {
      type: 'stdio',
      command: 'node',
      args: [SERVER_PATH],
      ...(Object.keys(env).length > 0 ? { env } : {})
    };

    writeJSON(path, mcp);
    log(`Updated ${path}${agentName ? ` (agent: ${agentName})` : ''}`);
  }

  log(`${files.length} project file(s) updated`);
}

// ============================================================
// Step 3: Update settings.json (hooks + permissions)
// ============================================================

function updateSettings() {
  logHeader('3. Settings (~/.claude/settings.json)');

  const settings = readJSON(SETTINGS) || {};
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  // --- Permissions ---
  const oldPerms = [
    'mcp__agent-bridge__register_agent',
    'mcp__agent-bridge__list_agents',
    'mcp__agent-bridge__send_message',
    'mcp__agent-bridge__read_messages',
    'mcp__agent-bridge__broadcast',
    'mcp__agent-bridge__share_context',
    'mcp__agent-bridge__get_context',
    'mcp__agent-bridge__save_checkpoint',
    'mcp__agent-bridge__load_checkpoint',
    'mcp__newcode-memory__retrieve_memories',
    'mcp__newcode-memory__store_conversation',
    'mcp__newcode-memory__judge_memories',
  ];

  const newPerms = [
    'mcp__mevoric__register_agent',
    'mcp__mevoric__list_agents',
    'mcp__mevoric__send_message',
    'mcp__mevoric__read_messages',
    'mcp__mevoric__broadcast',
    'mcp__mevoric__share_context',
    'mcp__mevoric__get_context',
    'mcp__mevoric__save_checkpoint',
    'mcp__mevoric__load_checkpoint',
    'mcp__mevoric__retrieve_memories',
    'mcp__mevoric__store_conversation',
    'mcp__mevoric__judge_memories',
  ];

  // Remove old, add new (avoid duplicates)
  let removedCount = 0;
  settings.permissions.allow = settings.permissions.allow.filter(p => {
    if (oldPerms.includes(p)) { removedCount++; return false; }
    return true;
  });

  let addedCount = 0;
  for (const perm of newPerms) {
    if (!settings.permissions.allow.includes(perm)) {
      settings.permissions.allow.push(perm);
      addedCount++;
    }
  }

  if (removedCount > 0) log(`Removed ${removedCount} old permissions`);
  if (addedCount > 0) log(`Added ${addedCount} new permissions`);

  // --- Hooks ---
  if (!settings.hooks) settings.hooks = {};

  // Old hook commands to detect and remove
  const oldHookPatterns = [
    'agent-bridge',
    'newcode-memory',
    'capture-prompt.py',
    'auto-ingest.py',
    'npx agent-bridge-mcp',
  ];

  function isOldHook(command) {
    return oldHookPatterns.some(p => command.includes(p));
  }

  function isMevoricHook(command) {
    return command.includes('Mevoric') || command.includes('mevoric');
  }

  // SessionStart
  settings.hooks.SessionStart = [{
    hooks: [{
      type: 'command',
      command: `node ${SERVER_PATH} --bootstrap-context`,
      timeout: 10
    }]
  }];

  // UserPromptSubmit
  settings.hooks.UserPromptSubmit = [{
    hooks: [
      {
        type: 'command',
        command: `node ${SERVER_PATH} --capture-prompt`,
        timeout: 5
      },
      {
        type: 'command',
        command: `node ${SERVER_PATH} --check-messages`,
        timeout: 5
      }
    ]
  }];

  // Stop
  settings.hooks.Stop = [{
    hooks: [{
      type: 'command',
      command: `node ${SERVER_PATH} --ingest`,
      timeout: 30
    }]
  }];

  log('Hooks updated (SessionStart, UserPromptSubmit, Stop)');

  writeJSON(SETTINGS, settings);
  log('Settings saved');
}

// ============================================================
// Step 4: Remove legacy pip packages
// ============================================================

function removeLegacyPipPackages() {
  logHeader('4. Legacy pip packages');

  const packagesToRemove = ['newcode-memory', 'agent-bridge-mcp'];
  let removed = 0;

  for (const pkg of packagesToRemove) {
    // Check if installed
    try {
      const result = execSync(`pip show ${pkg} 2>&1`, { encoding: 'utf8', timeout: 10000 });
      if (result.includes('Name:')) {
        // It's installed — remove it
        try {
          execSync(`pip uninstall ${pkg} -y 2>&1`, { encoding: 'utf8', timeout: 30000 });
          log(`Removed ${pkg} pip package (was auto-registering as duplicate MCP server)`);
          removed++;
        } catch (err) {
          log(`Warning: failed to remove ${pkg}: ${err.message}`);
        }
      }
    } catch {
      // Not installed or pip not available — skip
    }
  }

  // Also try pip3 in case pip points to a different Python
  for (const pkg of packagesToRemove) {
    try {
      const result = execSync(`pip3 show ${pkg} 2>&1`, { encoding: 'utf8', timeout: 10000 });
      if (result.includes('Name:')) {
        try {
          execSync(`pip3 uninstall ${pkg} -y 2>&1`, { encoding: 'utf8', timeout: 30000 });
          log(`Removed ${pkg} via pip3`);
          removed++;
        } catch {}
      }
    } catch {}
  }

  if (removed === 0) {
    log('No legacy pip packages found');
  }
}

// ============================================================
// Main
// ============================================================

function main() {
  console.log('Mevoric — init\n');

  // Parse args
  const args = process.argv.slice(2).filter(a => a !== 'init');
  let serverUrl = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server' && args[i + 1]) {
      serverUrl = args[i + 1];
      i++;
    }
  }

  // Step 1: Global config
  const dataDir = updateGlobalMcp(serverUrl);

  // Step 2: Project-level configs
  updateProjectMcpFiles(serverUrl, dataDir);

  // Step 3: Settings (hooks + permissions)
  updateSettings();

  // Step 4: Remove old pip packages that auto-register as MCP servers
  removeLegacyPipPackages();

  // Done
  logHeader('Done!');
  log('Restart VS Code (or close/reopen Claude Code) for changes to take effect.');
  log('');
  log('Tools available (12):');
  log('  Memory:      retrieve_memories, store_conversation, judge_memories');
  log('  Bridge:      register_agent, list_agents, send_message, read_messages, broadcast');
  log('  Context:     share_context, get_context');
  log('  Checkpoints: save_checkpoint, load_checkpoint');
  if (serverUrl) {
    log(`\nMemory server: ${serverUrl}`);
  } else {
    log('\nNo memory server configured. Memory tools will return errors.');
    log('Run: npx mevoric init --server http://your-server:4000');
  }
}

main();
