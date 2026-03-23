#!/usr/bin/env python3
"""Patch intake.py: accept project param, store as metadata with Mem0."""

with open("/home/toptiercrm/newcode/intake.py", "r") as f:
    content = f.read()

# 1. Update ingest function signature to accept project
content = content.replace(
    'async def ingest(messages: list[dict], user_id: str, conversation_id: str, source_machine: str = "unknown"):',
    'async def ingest(messages: list[dict], user_id: str, conversation_id: str, source_machine: str = "unknown", project: str | None = None):'
)

# 2. Pass metadata with project to Mem0's add() call
content = content.replace(
    "    result = await asyncio.to_thread(_mem0.add, messages, user_id=user_id)",
    "    metadata = {\"project\": project} if project else {}\n    result = await asyncio.to_thread(_mem0.add, messages, user_id=user_id, metadata=metadata)"
)

with open("/home/toptiercrm/newcode/intake.py", "w") as f:
    f.write(content)

print("intake.py patched OK")
