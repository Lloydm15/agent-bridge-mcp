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

## Infrastructure
- **Memory server:** 192.168.2.100:3100 (Cortex API — `/ingest`, `/retrieve`, `/feedback` endpoints). Mevoric is just the client.
- **Data dir:** `C:\Users\lloyd\AppData\Local\agent-bridge` (legacy path preserved)
- **Tests:** `cd c:\dev\Mevoric && node --test test/stress.test.mjs` (50 stress tests)
