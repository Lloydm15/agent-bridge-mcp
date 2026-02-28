# Mevoric

Unified memory + agent bridge for Claude Code. One MCP server, 12 tools, zero config.

## What It Does

- **Semantic memory** — Store and recall conversations across sessions using a remote memory server
- **Cross-tab messaging** — Send messages between Claude Code tabs in real time
- **Context sharing** — Share working knowledge between agents, persists after sessions end
- **Session checkpoints** — Save and restore structured session state automatically

## Install

```bash
npx mevoric init --server http://your-server:4000
```

This single command:
1. Adds the MCP server to `~/.claude/.mcp.json`
2. Updates any project-level `.mcp.json` files with old entries
3. Configures hooks in `~/.claude/settings.json`
4. Removes legacy packages (`newcode-memory`, `agent-bridge-mcp`) if installed

Restart VS Code after running.

## 12 Tools

| Group | Tools |
|-------|-------|
| **Memory** | `retrieve_memories`, `store_conversation`, `judge_memories` |
| **Bridge** | `register_agent`, `list_agents`, `send_message`, `read_messages`, `broadcast` |
| **Context** | `share_context`, `get_context` |
| **Checkpoints** | `save_checkpoint`, `load_checkpoint` |

## 3 Hooks (auto-configured)

| Event | What It Does |
|-------|-------------|
| **SessionStart** | Loads shared contexts, pending messages, and checkpoints |
| **UserPromptSubmit** | Captures prompts + delivers pending agent messages |
| **Stop** | Pairs prompt+response, POSTs to memory server, saves context + checkpoint |

## Memory Server

The memory tools (`retrieve_memories`, `store_conversation`, `judge_memories`) require a backend server that handles semantic search, embedding, and storage. Mevoric is the **client** — it calls your server's `/retrieve`, `/ingest`, and `/feedback` endpoints.

Without a memory server configured, the 9 bridge/context/checkpoint tools still work fine. Memory tools will return errors gracefully.

Set the server URL during init:

```bash
npx mevoric init --server http://192.168.2.100:4000
```

Or set it as an environment variable:

```
MEVORIC_SERVER_URL=http://192.168.2.100:4000
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEVORIC_SERVER_URL` | *(none)* | Memory server URL (required for memory tools) |
| `MEVORIC_DATA_DIR` | OS-specific app data | Directory for agent data, messages, contexts |
| `MEVORIC_AGENT_NAME` | *(auto-generated)* | Human-readable name for this agent |

## How It Works

Mevoric runs as a single Node.js MCP server via stdio. Claude Code starts it automatically.

**Agent Bridge:** Each Claude Code tab registers as an agent with a name. Agents communicate through file-based messaging in the data directory. A heartbeat file tracks liveness — agents that stop writing heartbeats are cleaned up automatically.

**Memory:** On session end, the Stop hook pairs the user's prompt with the assistant's response and POSTs it to your memory server for storage. On the next session, `retrieve_memories` searches for relevant past conversations.

**Checkpoints:** Structured snapshots of your working state (task, files touched, decisions made). Auto-saved on session end, auto-loaded on session start. Expire after 24 hours.

## Requirements

- Node.js 18+
- Claude Code CLI

## License

MIT
