#!/usr/bin/env python3
"""Patch server.py: add project + limit to request models, pass to retrieve/ingest."""

with open("/home/toptiercrm/newcode/server.py", "r") as f:
    content = f.read()

# 1. Add project + limit to RetrieveRequest
content = content.replace(
    '''class RetrieveRequest(BaseModel):
    query: str
    user_id: str = "lloyd"
    conversation_id: str | None = None''',
    '''class RetrieveRequest(BaseModel):
    query: str
    user_id: str = "lloyd"
    conversation_id: str | None = None
    project: str | None = None
    limit: int = 50'''
)

# 2. Add project to IngestRequest
content = content.replace(
    '''class IngestRequest(BaseModel):
    messages: list[dict]
    user_id: str = "lloyd"
    conversation_id: str | None = None
    source_machine: str = "unknown"''',
    '''class IngestRequest(BaseModel):
    messages: list[dict]
    user_id: str = "lloyd"
    conversation_id: str | None = None
    source_machine: str = "unknown"
    project: str | None = None'''
)

# 3. Pass limit + project to retrieve() calls (both /retrieve and /api/retrieve)
# There are two identical lines — replace both
content = content.replace(
    "    memories = await retrieve(req.query, req.user_id, conversation_id)",
    "    memories = await retrieve(req.query, req.user_id, conversation_id, limit=req.limit, project=req.project)"
)

# 4. Pass project to ingest()
content = content.replace(
    "    await ingest(req.messages, req.user_id, conversation_id, machine)",
    "    await ingest(req.messages, req.user_id, conversation_id, machine, project=req.project)"
)

with open("/home/toptiercrm/newcode/server.py", "w") as f:
    f.write(content)

print("server.py patched OK")
