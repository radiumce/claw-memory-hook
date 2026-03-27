/**
 * Minimal Local Interfaces for OpenClaw Event Hooks
 * Completely removes dependency on OpenClaw source directory.
 */

export interface HookEvent {
  type: "command" | "message" | "lifecycle" | string;
  action?: "new" | "reset" | "receive" | "send" | string;
  sessionKey: string;
  timestamp: number;
  context?: {
    workspaceDir?: string;
    sessionEntry?: {
      sessionFile?: string;
      sessionId?: string;
    };
    previousSessionEntry?: {
      sessionFile?: string;
      sessionId?: string;
    };
    [key: string]: any;
  };
}

export type HookHandler = (event: HookEvent) => Promise<void>;
