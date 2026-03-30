# Mevoric

Unified Memory + Agent Bridge. Replaced 3 separate systems (newcode-memory, agent-bridge, Python hooks) with ONE npm package.

## Tools (12)
`retrieve_memories`, `store_conversation`, `judge_memories`, `register_agent`, `list_agents`, `send_message`, `read_messages`, `broadcast`, `share_context`, `get_context`, `save_checkpoint`, `load_checkpoint`

## Hooks (3)
- `--bootstrap-context` (SessionStart)
- `--capture-prompt` + `--check-messages` (UserPromptSubmit)
- `--ingest` (Stop)

## Setup
`npx mevoric init --server http://192.168.2.100:3100` — handles global config, project configs, hooks, permissions, legacy pip cleanup

## How It Runs
- **Hub** runs on the Linux server (192.168.2.100:4100) via pm2 as `mevoric-hub`
  - Start: `ssh to server → pm2 start hub.mjs --name mevoric-hub`
  - Auto-restarts on crash and on server reboot (pm2 saved)
- **MCP client** (`server.mjs`) runs locally on Lloyd's PC via Claude Code's MCP config
  - Path: `C:/dev/Mevoric/server.mjs`
  - Connects to Cortex at `http://192.168.2.100:3100`
  - Connects to hub at `http://192.168.2.100:4100`
  - Data dir: `C:\Users\lloyd\AppData\Local\agent-bridge`

## Infrastructure
- **Memory server:** 192.168.2.100:3100 (Cortex API — `/ingest`, `/retrieve`, `/feedback` endpoints). Mevoric is just the client.
- **Hub:** 192.168.2.100:4100 (pm2: mevoric-hub, handles agent messaging + knowledge sharing)
- **Data dir:** `C:\Users\lloyd\AppData\Local\agent-bridge` (legacy path preserved)
- **Tests:** `cd c:\dev\Mevoric && node --test test/stress.test.mjs` (50 stress tests)
