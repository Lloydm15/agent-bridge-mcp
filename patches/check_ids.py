#!/usr/bin/env python3
import asyncio
from db import get_pool

async def check():
    pool = await get_pool()
    rows = await pool.fetch("SELECT mem0_id, memory_content FROM memory_map LIMIT 3")
    for r in rows:
        mid = r["mem0_id"]
        content = r["memory_content"][:80]
        print(f"ID: {mid}")
        print(f"Content: {content}")
        print()

asyncio.run(check())
