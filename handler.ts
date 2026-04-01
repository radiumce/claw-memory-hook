import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { HookEvent, HookHandler } from "./types.ts";
import { findPreviousSessionFile } from "./transcript.ts";

import { fileURLToPath } from "node:url";

interface HookConfig {
  allowedRoles: string[];
  xmemoryApiUrl: string;
  initialSyncDays: number; // -1 = all, >0 = only files created within N days
  namespace?: string; // Optional namespace for separation in xmemory
}

interface Checkpoint {
  lastSessionFile: string;
  lastMessageId: string | null;
  syncedFiles?: string[]; // Track which files have been fully synced (for initial sync)
  fileCheckpoints?: Record<string, string>; // Per-file last message ID for peer-isolation support
}

// -------------------------------------------------------------
// Rule & Checkpoint Setup
// -------------------------------------------------------------
async function loadConfig(): Promise<HookConfig> {
  const defaults: HookConfig = {
    allowedRoles: ["user", "assistant"],
    xmemoryApiUrl: process.env.XMEMORY_WEBHOOK_URL || "http://127.0.0.1:8000/api/v1/memory/push",
    initialSyncDays: 3
  };
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const configPath = path.join(__dirname, "config.json");
    const data = await fs.readFile(configPath, "utf-8");
    const json = JSON.parse(data);
    
    if (json) {
       if (Array.isArray(json.allowedRoles)) {
         defaults.allowedRoles = json.allowedRoles;
       }
       if (typeof json.xmemoryApiUrl === "string" && json.xmemoryApiUrl.trim() !== "") {
         defaults.xmemoryApiUrl = json.xmemoryApiUrl;
       }
       if (typeof json.initialSyncDays === "number") {
         defaults.initialSyncDays = json.initialSyncDays;
       }
       if (typeof json.namespace === "string" && json.namespace.trim() !== "") {
         defaults.namespace = json.namespace;
       }
    }
  } catch {
    // Ignore errors, default to basic config
  }
  return defaults;
}

async function loadCheckpoint(checkpointPath: string): Promise<Checkpoint> {
  try {
    const data = await fs.readFile(checkpointPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return { lastSessionFile: "", lastMessageId: null, syncedFiles: [] };
  }
}

async function saveCheckpoint(checkpointPath: string, checkpoint: Checkpoint): Promise<void> {
  try {
    // Prune fileCheckpoints: remove entries for deleted files or files inactive for over 30 days
    if (checkpoint.fileCheckpoints) {
      const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
      const now = Date.now();
      const pruned: Record<string, string> = {};
      for (const [filePath, msgId] of Object.entries(checkpoint.fileCheckpoints)) {
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs < STALE_THRESHOLD_MS) {
            pruned[filePath] = msgId;
          }
        } catch {
          // File no longer exists, drop from checkpoint
        }
      }
      checkpoint.fileCheckpoints = Object.keys(pruned).length > 0 ? pruned : undefined;
    }

    const dir = path.dirname(checkpointPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf-8");
  } catch (err) {
    console.error("[xmemory-hook] Failed to save checkpoint:", err);
  }
}

// -------------------------------------------------------------
// Session File Discovery
// -------------------------------------------------------------
async function findSessionFilesInRange(sessionsDir: string, syncDays: number): Promise<string[]> {
  try {
    const files = await fs.readdir(sessionsDir);
    const jsonlFiles = files.filter(
      (name) => name.endsWith(".jsonl") && !name.includes(".reset.")
    );

    if (jsonlFiles.length === 0) return [];

    // If syncDays == -1, return all
    if (syncDays < 0) {
      const result = jsonlFiles.map((f) => path.join(sessionsDir, f));
      result.sort();
      console.log(`[xmemory-hook] Initial sync: found ${result.length} session files (all)`);
      return result;
    }

    // Filter by file creation/modification time
    const cutoff = Date.now() - syncDays * 24 * 60 * 60 * 1000;
    const filtered: string[] = [];

    for (const file of jsonlFiles) {
      const filePath = path.join(sessionsDir, file);
      try {
        const stat = await fs.stat(filePath);
        // Use birthtime (creation time) if available, otherwise mtime
        const fileTime = stat.birthtime?.getTime() || stat.mtime.getTime();
        if (fileTime >= cutoff) {
          filtered.push(filePath);
        }
      } catch {
        // Skip files we can't stat
      }
    }

    filtered.sort();
    console.log(`[xmemory-hook] Initial sync: found ${filtered.length} session files within ${syncDays} days (total ${jsonlFiles.length} in dir)`);
    return filtered;
  } catch {
    return [];
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
// Send to Webhook
// -------------------------------------------------------------
async function sendToWebhook(
  config: HookConfig,
  agentId: string,
  sessionId: string,
  event: { type: string; action?: string },
  messages: any[]
): Promise<void> {
  const payload = {
    source: "openclaw",
    event: event.type,
    action: event.action,
    agentId,
    sessionId,
    data: messages,
    ...(config.namespace ? { namespace: config.namespace } : {})
  };

  if (config.xmemoryApiUrl) {
    console.log(`[xmemory-hook] Forwarding ${messages.length} RAW records to XMemory: ${config.xmemoryApiUrl}`);
    const res = await fetch(config.xmemoryApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
       throw new Error(`XMemory Webhook returned status ${res.status}`);
    }
  } else {
    console.log(`[xmemory-hook] Fetched ${messages.length} messages. xmemoryApiUrl not configured.`);
  }
}

// -------------------------------------------------------------
// Main Handler
// -------------------------------------------------------------
const xmemoryHookHandler: HookHandler = async (event) => {
  // Debug: always log to confirm handler is being invoked
  console.log(`[xmemory-hook] 🔔 Handler invoked: type=${event.type}, action=${event.action}, sessionKey=${event.sessionKey}`);

  const isResetCommand = event.type === "command" && (event.action === "new" || event.action === "reset");
  const isMessageReceived = event.type === "message" && event.action === "received";

  if (!isResetCommand && !isMessageReceived) {
    console.log(`[xmemory-hook] ⏭️ Skipping: not a relevant event`);
    return;
  }

  try {
    const context = event.context || {};
    // sessionKey format: "agent:main:tui-xxx" -> parts[1] = agentId
    const sessionKeyParts = event.sessionKey.split(":");
    const agentId = sessionKeyParts[1] || "unknown";

    // Resolve base OpenClaw state directory
    const defaultStateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");

    // Sessions live at ~/.openclaw/agents/{agentId}/sessions/
    const sessionsDir =
      context.workspaceDir && typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
        ? path.join(context.workspaceDir, "sessions")
        : path.join(defaultStateDir, "agents", agentId, "sessions");

    // Checkpoint stored alongside sessions dir (same parent)
    const checkpointFile = path.join(sessionsDir, "..", ".claw-memory-hook-checkpoint");

    console.log(`[xmemory-hook] Resolved: agentId=${agentId}, sessionsDir=${sessionsDir}, checkpoint=${checkpointFile}`);

    // Load Checkpoint & Config
    const checkpoint = await loadCheckpoint(checkpointFile);
    const config = await loadConfig();

    // ---------------------------------------------------------------
    // First-run: Initial sync of historical session files
    // ---------------------------------------------------------------
    const isFirstRun = !checkpoint.lastSessionFile && !checkpoint.lastMessageId;
    if (isFirstRun) {
      console.log(`[xmemory-hook] First run detected. Performing initial sync (initialSyncDays=${config.initialSyncDays})...`);

      const historicalFiles = await findSessionFilesInRange(sessionsDir, config.initialSyncDays);
      const syncedFiles: string[] = [];
      const initFileCheckpoints: Record<string, string> = {};

      for (const filePath of historicalFiles) {
        const { messages, newLastId } = await pullMessagesFrom(
          filePath,
          { lastSessionFile: "", lastMessageId: null, syncedFiles: [] },
          config.allowedRoles
        );

        if (messages.length > 0) {
          const fileName = path.basename(filePath, ".jsonl");
          await sendToWebhook(config, agentId, fileName, event, messages);
        }

        if (newLastId) {
          initFileCheckpoints[filePath] = newLastId;
        }

        syncedFiles.push(filePath);
        console.log(`[xmemory-hook] Initial sync: processed ${filePath} (${messages.length} messages)`);
      }

      const lastFile = historicalFiles[historicalFiles.length - 1];
      await saveCheckpoint(checkpointFile, {
        lastSessionFile: lastFile ?? "",
        lastMessageId: lastFile ? (initFileCheckpoints[lastFile] ?? null) : null,
        syncedFiles,
        fileCheckpoints: initFileCheckpoints,
      });

      console.log(`[xmemory-hook] Initial sync complete. Synced ${syncedFiles.length} files.`);
    }

    // ---------------------------------------------------------------
    // Normal incremental mode: process the current event's session file
    // ---------------------------------------------------------------
    const freshCheckpoint = await loadCheckpoint(checkpointFile);

    let currentSessionFile: string | undefined;
    let currentSessionId: string | undefined;

    if (isResetCommand) {
      // command:new / command:reset — sessionEntry is available in context
      const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<string, unknown>;
      currentSessionId = sessionEntry.sessionId as string;
      currentSessionFile = (sessionEntry.sessionFile as string) || undefined;

      if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
        const recoveredSessionFile = await findPreviousSessionFile({ sessionsDir, currentSessionFile, sessionId: currentSessionId });
        if (recoveredSessionFile) {
          currentSessionFile = recoveredSessionFile;
        }
      }
    } else if (isMessageReceived) {
      // message:received — no sessionEntry; find the most recently modified .jsonl
      try {
        const files = await fs.readdir(sessionsDir);
        const jsonlFiles = files.filter(
          (f) => f.endsWith(".jsonl") && !f.includes(".reset.") && f !== "sessions.json"
        );

        let latestFile: string | undefined;
        let latestMtime = 0;
        for (const f of jsonlFiles) {
          const fp = path.join(sessionsDir, f);
          try {
            const stat = await fs.stat(fp);
            if (stat.mtimeMs > latestMtime) {
              latestMtime = stat.mtimeMs;
              latestFile = fp;
            }
          } catch {}
        }
        currentSessionFile = latestFile;
        if (currentSessionFile) {
          currentSessionId = path.basename(currentSessionFile, ".jsonl");
        }
        console.log(`[xmemory-hook] message:received -> latest session file: ${currentSessionFile}`);
      } catch (err) {
        console.error(`[xmemory-hook] Failed to scan sessions dir ${sessionsDir}:`, err);
      }
    }

    if (!currentSessionFile) {
      console.log("[xmemory-hook] No session file found to process for event:", event.action);
      return;
    }

    // ---------------------------------------------------------------
    // Session switch: flush remaining messages from previous session
    // ---------------------------------------------------------------
    let activeCheckpoint = freshCheckpoint;
    const previousSessionFile = freshCheckpoint.lastSessionFile;
    const isSessionSwitch =
      previousSessionFile &&
      previousSessionFile !== currentSessionFile &&
      previousSessionFile !== "";

    if (isSessionSwitch) {
      console.log(`[xmemory-hook] 🔄 Session switch detected: ${path.basename(previousSessionFile)} → ${path.basename(currentSessionFile)}`);
      const { messages: remainingMessages, newLastId: prevLastId } = await pullMessagesFrom(
        previousSessionFile,
        freshCheckpoint,
        config.allowedRoles
      );

      if (remainingMessages.length > 0) {
        const prevSessionId = path.basename(previousSessionFile, ".jsonl");
        console.log(`[xmemory-hook] 📤 Flushing ${remainingMessages.length} remaining messages from previous session: ${prevSessionId}`);
        await sendToWebhook(config, agentId, prevSessionId, event, remainingMessages);
      }

      // Update checkpoint to mark previous session as flushed up to this point
      // Note: do NOT remove from fileCheckpoints — the previous session may still be active
      // (e.g. another peer's session picked up via mtime heuristic). Stale entries are
      // cleaned by fs.access pruning in saveCheckpoint when the file is eventually deleted.
      activeCheckpoint = {
        ...freshCheckpoint,
        lastSessionFile: previousSessionFile,
        lastMessageId: prevLastId ?? freshCheckpoint.lastMessageId,
        fileCheckpoints: {
          ...(freshCheckpoint.fileCheckpoints ?? {}),
          [previousSessionFile]: prevLastId ?? freshCheckpoint.lastMessageId ?? "",
        },
      };
      await saveCheckpoint(checkpointFile, activeCheckpoint);
      console.log(`[xmemory-hook] ✅ Previous session flushed and checkpoint updated`);
    }

    // ---------------------------------------------------------------
    // Process current session file
    // ---------------------------------------------------------------
    // For a new session file (different from checkpoint), read from the beginning
    // On session switch, resume from per-file checkpoint instead of re-reading from start
    const checkpointForCurrent: Checkpoint = isSessionSwitch
      ? { lastSessionFile: currentSessionFile, lastMessageId: activeCheckpoint.fileCheckpoints?.[currentSessionFile] ?? null, syncedFiles: [] }
      : activeCheckpoint;

    const { messages, newLastId } = await pullMessagesFrom(currentSessionFile, checkpointForCurrent, config.allowedRoles);

    if (messages.length === 0) {
      if (newLastId !== activeCheckpoint.lastMessageId || currentSessionFile !== activeCheckpoint.lastSessionFile) {
        await saveCheckpoint(checkpointFile, {
          ...activeCheckpoint,
          lastSessionFile: currentSessionFile,
          lastMessageId: newLastId,
          fileCheckpoints: {
            ...(activeCheckpoint.fileCheckpoints ?? {}),
            ...(newLastId ? { [currentSessionFile]: newLastId } : {}),
          },
        });
      }
      return;
    }

    // Send to webhook
    await sendToWebhook(config, agentId, currentSessionId || path.basename(currentSessionFile, ".jsonl"), event, messages);

    // Save Checkpoint
    await saveCheckpoint(checkpointFile, {
      ...activeCheckpoint,
      lastSessionFile: currentSessionFile,
      lastMessageId: newLastId,
      fileCheckpoints: {
        ...(activeCheckpoint.fileCheckpoints ?? {}),
        ...(newLastId ? { [currentSessionFile]: newLastId } : {}),
      },
    });

  } catch (err) {
    console.error("[xmemory-hook] Error processing event:", err);
  }
};

export default xmemoryHookHandler;

