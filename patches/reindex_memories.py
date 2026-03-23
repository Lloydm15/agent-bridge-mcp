#!/usr/bin/env python3
"""
Re-embed all memories from PostgreSQL memory_map into Qdrant.
Generates fresh embeddings and inserts directly into the vector store,
matching Mem0's expected payload format exactly.
"""
import asyncio
import hashlib
import os
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

from openai import OpenAI
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct

from db import get_pool

# Match the Mem0 config exactly
QDRANT_PATH = "./qdrant_storage"
COLLECTION = "memories"
EMBED_MODEL = "text-embedding-3-small"
BATCH_SIZE = 100  # OpenAI supports up to 2048 inputs per batch

openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
qdrant = QdrantClient(path=QDRANT_PATH)


def get_embeddings(texts):
    response = openai_client.embeddings.create(model=EMBED_MODEL, input=texts)
    return [item.embedding for item in response.data]


async def reindex():
    pool = await get_pool()

    rows = await pool.fetch(
        "SELECT mem0_id, memory_content, user_id, created_at, updated_at "
        "FROM memory_map ORDER BY created_at"
    )
    total = len(rows)
    print(f"Found {total} memories to re-embed")

    # Check current state
    try:
        info = qdrant.get_collection(COLLECTION)
        print(f"Qdrant currently has {info.points_count} points")
    except Exception:
        print("Qdrant collection exists but is empty")

    success = 0
    skipped = 0

    for batch_start in range(0, total, BATCH_SIZE):
        batch = rows[batch_start:batch_start + BATCH_SIZE]
        valid_rows = []
        texts = []

        for row in batch:
            content = row["memory_content"]
            if not content or not content.strip():
                skipped += 1
                continue
            valid_rows.append(row)
            texts.append(content)

        if not texts:
            continue

        try:
            embeddings = get_embeddings(texts)

            points = []
            for emb, row in zip(embeddings, valid_rows):
                content = row["memory_content"]
                created = row["created_at"]
                updated = row["updated_at"]

                # Match Mem0's exact payload format
                payload = {
                    "data": content,
                    "hash": hashlib.md5(content.encode()).hexdigest(),
                    "user_id": row["user_id"],
                    "created_at": created.isoformat() if created else datetime.now(timezone.utc).isoformat(),
                    "updated_at": (updated or created or datetime.now(timezone.utc)).isoformat(),
                }

                points.append(PointStruct(
                    id=row["mem0_id"],  # Use the original mem0 UUID
                    vector=emb,
                    payload=payload,
                ))

            qdrant.upsert(collection_name=COLLECTION, points=points)
            success += len(points)
            done = min(batch_start + BATCH_SIZE, total)
            print(f"  [{done}/{total}] +{len(points)} embedded ({success} total)")

        except Exception as e:
            done = min(batch_start + BATCH_SIZE, total)
            print(f"  [{done}/{total}] BATCH FAILED: {e}")

    # Verify
    try:
        info = qdrant.get_collection(COLLECTION)
        print(f"\nDone! Qdrant now has {info.points_count} points")
    except Exception:
        pass

    print(f"Results: {success} embedded, {skipped} skipped (empty)")


if __name__ == "__main__":
    asyncio.run(reindex())
