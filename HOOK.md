---
name: xmemory-hook
description: "Pulls OpenClaw session logs and syncs them to XMemory"
homepage: ""
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["command:new", "command:reset", "message:receive"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "custom", "kind": "local", "label": "XMemory Integration Hook" }],
      },
  }
---

# XMemory Integration Hook

This hook automatically captures your OpenClaw session messages and synchronizes them with the XMemory agent memory tracking system in real time. 

It is designed to be a **zero-dependency, lightweight data shipper**. It extracts raw Native OpenClaw JSONL events and securely forwards them to the XMemory Python backend adapters.

## What It Does

When triggered by a new message (`message:receive`) or a session reset (`/new` or `/reset`):

1. **Locates Session File**: Automatically finds the current (or just-ended) `xxxx.jsonl` conversation file.
2. **Stateful Checkpointing**: Reads `xmemory-hook-checkpoint.json` to find the last successfully synced message ID, ensuring no duplicate messages are sent.
3. **Role Filtering**: Filters new messages based on allowed roles configured in `extraction_rule.json`.
4. **Webhook Sync**: POSTs the raw JSON array to the `XMEMORY_WEBHOOK_URL`.
5. **Advances Checkpoint**: If the webhook returns successfully, the checkpoint is updated.

## Output Payload

The hook sends a JSON POST request to your webhook with the following structure:

```json
{
  "event": "message",
  "action": "receive",
  "agentId": "main",
  "sessionId": "abc123def456",
  "data": [
    {
      "type": "message",
      "id": "msg_01",
      "timestamp": 1712345678,
      "message": {
        "role": "user",
        "content": "Hello world"
      }
    }
  ]
}
```

## Configuration

### 1. Webhook Endpoint
You must configure the target webhook URL via the environment variable where OpenClaw runs:
```bash
export XMEMORY_WEBHOOK_URL="http://127.0.0.1:8000/hooks/claw-memory"
```

### 2. Message Role Filtering
By default, the hook intercepts `user` and `assistant` messages. To change this, edit the `extraction_rule.json` file located in the same directory as the hook code:

```json
{
  "allowedRoles": ["user", "assistant"]
}
```

## State Management

The hook automatically maintains its state to ensure accurate syncing across restarts or network interruptions. It creates:
- `~/.openclaw/workspace/memory/xmemory-hook-checkpoint.json`

If you ever need to force a full re-sync of a session, safely delete or edit this checkpoint file.
