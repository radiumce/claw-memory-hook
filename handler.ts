import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { HookEvent, HookHandler } from "./types.js";
import { findPreviousSessionFile } from "./transcript.js";

import { fileURLToPath } from "node:url";

// Webhook for XMemory
const XMEMORY_WEBHOOK_URL = process.env.XMEMORY_WEBHOOK_URL || "";

interface Checkpoint {
  lastSessionFile: string;
  lastMessageId: string | null;
}

// -------------------------------------------------------------
// Rule & Checkpoint Setup
// -------------------------------------------------------------
async function loadAllowedRoles(): Promise<string[]> {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const rulePath = path.join(__dirname, "extraction_rule.json");
    const data = await fs.readFile(rulePath, "utf-8");
    const json = JSON.parse(data);
    if (json && Array.isArray(json.allowedRoles)) {
      return json.allowedRoles;
    }
  } catch {
    // Ignore errors, default to basic roles
  }
  return ["user", "assistant"];
}
async function loadCheckpoint(checkpointPath: string): Promise<Checkpoint> {
  try {
    const data = await fs.readFile(checkpointPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return { lastSessionFile: "", lastMessageId: null };
  }
}

async function saveCheckpoint(checkpointPath: string, checkpoint: Checkpoint): Promise<void> {
  try {
    const dir = path.dirname(checkpointPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf-8");
  } catch (err) {
    console.error("[xmemory-hook] Failed to save checkpoint:", err);
  }
}

// -------------------------------------------------------------
// Read & Filter Messages
// -------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pullMessagesFrom(sessionFilePath: string, checkpoint: Checkpoint, allowedRoles: string[]): Promise<{ messages: any[], newLastId: string | null }> {
  let content = "";
  try {
    content = await fs.readFile(sessionFilePath, "utf-8");
  } catch (err) {
    return { messages: [], newLastId: checkpoint.lastMessageId };
  }

  const lines = content.trim().split("\n");
  const result: any[] = [];
  
  // If we are reading the same session file, skip until we find the checkpoint ID
  let skipMode = checkpoint.lastSessionFile === sessionFilePath && checkpoint.lastMessageId !== null;
  let newLastId: string | null = checkpoint.lastMessageId;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    
    try {
      const entry = JSON.parse(line);
      const currentIdStr = entry.id ? String(entry.id) : `index_${i}_${entry.timestamp || ""}`;

      // Update the last ID seen from this file regardless of whether it's a message or valid
      newLastId = currentIdStr;

      // If we are looking for the checkpoint, check if we found it
      if (skipMode) {
        if (currentIdStr === checkpoint.lastMessageId) {
          skipMode = false; // Stop skipping on the NEXT line
        }
        continue;
      }

      // We are past the checkpoint, let's process the message
      if (entry.type === "message" || entry.type === "completion") {
        const role = entry.message?.role;
        // Role Filtering
        if (role && allowedRoles.includes(role)) {
          result.push(entry);
        }
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  return { messages: result, newLastId };
}

// -------------------------------------------------------------
// Main Handler
// -------------------------------------------------------------
const xmemoryHookHandler: HookHandler = async (event) => {
  const isResetCommand = event.type === "command" && (event.action === "new" || event.action === "reset");
  const isMessageReceive = event.type === "message" && event.action === "receive";

  if (!isResetCommand && !isMessageReceive) {
    return;
  }

  try {
    const context = event.context || {};
    const agentId = event.sessionKey.split(":")[1] || "unknown"; // Default 'agent:main:main' -> 'main'
    
    // Resolve workspaceDir
    const defaultStateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
    const workspaceDir =
      context.workspaceDir && typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
        ? context.workspaceDir
        : path.join(defaultStateDir, "workspace");

    // Checkpoint Location
    const checkpointFile = path.join(workspaceDir, "memory", "xmemory-hook-checkpoint.json");

    // Locate the proper session file
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<string, unknown>;
    const currentSessionId = sessionEntry.sessionId as string;
    let currentSessionFile = (sessionEntry.sessionFile as string) || undefined;

    if (isResetCommand && (!currentSessionFile || currentSessionFile.includes(".reset."))) {
      const sessionsDirs = new Set<string>();
      if (currentSessionFile) sessionsDirs.add(path.dirname(currentSessionFile));
      sessionsDirs.add(path.join(workspaceDir, "sessions"));

      for (const sessionsDir of sessionsDirs) {
        const recoveredSessionFile = await findPreviousSessionFile({ sessionsDir, currentSessionFile, sessionId: currentSessionId });
        if (recoveredSessionFile) {
          currentSessionFile = recoveredSessionFile;
          break;
        }
      }
    }

    if (!currentSessionFile) {
      console.log("[xmemory-hook] No session file found to process for event:", event.action);
      return;
    }

    // Step 1: Load Checkpoint & Rules
    const checkpoint = await loadCheckpoint(checkpointFile);
    const allowedRoles = await loadAllowedRoles();

    // Step 2: Read JSONL & filter messages strictly since checkpoint
    const { messages, newLastId } = await pullMessagesFrom(currentSessionFile, checkpoint, allowedRoles);
    
    if (messages.length === 0) {
      // Always update checkpoint even if there were no matching allowed roles
      // Because there might be system events we scanned past
      if (newLastId !== checkpoint.lastMessageId || currentSessionFile !== checkpoint.lastSessionFile) {
        await saveCheckpoint(checkpointFile, { lastSessionFile: currentSessionFile, lastMessageId: newLastId });
      }
      return;
    }

    // Step 3: Emit to Webhook
    const payload = {
      event: event.type,
      action: event.action,
      agentId,
      sessionId: currentSessionId,
      data: messages
    };

    if (XMEMORY_WEBHOOK_URL) {
      console.log(`[xmemory-hook] Forwarding ${messages.length} filtered messages since checkpoint to Webhook.`);
      const res = await fetch(XMEMORY_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
         throw new Error(`XMemory Webhook returned status ${res.status}`);
      }
    } else {
      console.log(`[xmemory-hook] Fetched ${messages.length} messages. XMEMORY_WEBHOOK_URL not configured.`);
    }

    // Step 4: Save Checkpoint
    await saveCheckpoint(checkpointFile, {
      lastSessionFile: currentSessionFile,
      lastMessageId: newLastId
    });

  } catch (err) {
    console.error("[xmemory-hook] Error processing event:", err);
  }
};

export default xmemoryHookHandler;
