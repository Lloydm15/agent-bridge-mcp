#!/usr/bin/env python3
"""Fix duplicate fields in server.py request models."""

with open("/home/toptiercrm/newcode/server.py", "r") as f:
    content = f.read()

# Fix IngestRequest — remove duplicate project line
content = content.replace(
    '''class IngestRequest(BaseModel):
    messages: list[dict]
    user_id: str = "lloyd"
    conversation_id: str | None = None
    source_machine: str = "unknown"
    project: str | None = None
    project: str | None = None''',
    '''class IngestRequest(BaseModel):
    messages: list[dict]
    user_id: str = "lloyd"
    conversation_id: str | None = None
    source_machine: str = "unknown"
    project: str | None = None'''
)

# Fix RetrieveRequest — remove duplicate project + limit lines
content = content.replace(
    '''class RetrieveRequest(BaseModel):
    query: str
    user_id: str = "lloyd"
    conversation_id: str | None = None
    project: str | None = None
    limit: int = 50
    project: str | None = None
    limit: int = 50''',
    '''class RetrieveRequest(BaseModel):
    query: str
    user_id: str = "lloyd"
    conversation_id: str | None = None
    project: str | None = None
    limit: int = 50'''
)

with open("/home/toptiercrm/newcode/server.py", "w") as f:
    f.write(content)

print("Duplicates fixed OK")
