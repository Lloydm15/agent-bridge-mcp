#!/usr/bin/env python3
"""Patch retrieval.py: add limit param, log threshold, project support."""

with open("/home/toptiercrm/newcode/retrieval.py", "r") as f:
    content = f.read()

# Replace function signature and body
old_sig = "async def retrieve(query: str, user_id: str, conversation_id: str) -> list[dict]:"
new_sig = "async def retrieve(query: str, user_id: str, conversation_id: str, limit: int = 50, project: str | None = None) -> list[dict]:"
content = content.replace(old_sig, new_sig)

# Add LOG_THRESHOLD constant after docstring
old_doc_end = '    Returns list of {"mem0_id", "memory", "score", "rank"}.\n    """'
new_doc_end = '    Returns list of {"mem0_id", "memory", "score", "rank"}.\n    """\n    LOG_THRESHOLD = 0.15  # Don\'t log garbage results below this score'
content = content.replace(old_doc_end, new_doc_end)

# Replace Mem0 search call to pass limit
old_search = "    result = await asyncio.to_thread(_mem0.search, query, user_id=user_id)"
new_search = "    result = await asyncio.to_thread(_mem0.search, query, user_id=user_id, limit=limit)"
content = content.replace(old_search, new_search)

# Add threshold filter before rank assignment
old_rank = """    # Assign final ranks and log
    for rank, mem in enumerate(memories, start=1):"""
new_rank = """    # Only keep results above threshold
    memories = [m for m in memories if m["score"] >= LOG_THRESHOLD]

    # Assign final ranks and log (only meaningful results)
    for rank, mem in enumerate(memories, start=1):"""
content = content.replace(old_rank, new_rank)

with open("/home/toptiercrm/newcode/retrieval.py", "w") as f:
    f.write(content)

print("retrieval.py patched OK")
