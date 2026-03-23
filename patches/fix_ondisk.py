#!/usr/bin/env python3
"""Fix intake.py: set on_disk=True so Qdrant doesn't wipe data on restart."""

with open("/home/toptiercrm/newcode/intake.py", "r") as f:
    content = f.read()

content = content.replace(
    '"embedding_model_dims": 1536,\n        }',
    '"embedding_model_dims": 1536,\n            "on_disk": True,\n        }'
)

with open("/home/toptiercrm/newcode/intake.py", "w") as f:
    f.write(content)

print("intake.py patched: on_disk=True")
