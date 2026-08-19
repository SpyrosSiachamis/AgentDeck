/**
 * Internal, adapter-independent event vocabulary. Every CLI adapter translates
 * its own native output into these types, so the session manager, the wire
 * protocol and the UI never learn anything about a specific CLI.
 */

export type SessionEventType =
  | 'session_started'
  | 'turn_started'
  | 'message'
  | 'message_delta'
  | 'thinking'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'command_started'
  | 'command_finished'
  | 'turn_finished'
  | 'permission_request'
  | 'permission_resolved'
  | 'error'
  | 'session_cancelled'
  | 'session_finished'
  | 'notice';

export type SessionEventBody =
  | { type: 'session_started'; cliSessionId: string | null; model: string | null; resumed: boolean }
  | { type: 'turn_started'; instructionId: string; text: string }
  | { type: 'message'; role: 'assistant' | 'user'; blockId: string; text: string; truncated?: boolean }
  | { type: 'message_delta'; blockId: string; text: string }
  | { type: 'thinking'; blockId: string; text: string; truncated?: boolean }
  | { type: 'thinking_delta'; blockId: string; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; summary: string; input?: unknown }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; content: string; truncated?: boolean }
  | { type: 'command_started'; toolUseId: string; command: string; description?: string }
  | { type: 'command_finished'; toolUseId: string; isError: boolean; output: string; truncated?: boolean }
  | {
      type: 'turn_finished';
      isError: boolean;
      durationMs?: number;
      costUsd?: number;
      numTurns?: number;
      result?: string;
    }
  | {
      type: 'permission_request';
      requestId: string;
      toolName: string;
      displayName: string;
      /** One-line description of what is about to run. */
      summary: string;
      /** The command itself when the tool is a shell invocation. */
      command?: string;
      input?: unknown;
    }
  | {
      type: 'permission_resolved';
      requestId: string;
      decision: 'allow' | 'deny';
      decidedBy: string | null;
      reason?: string;
    }
  | { type: 'error'; message: string; detail?: string; fatal: boolean }
  | { type: 'session_cancelled'; reason: string }
  | { type: 'session_finished'; reason: string; code: number | null; signal: string | null }
  | { type: 'notice'; message: string };

/** An event as stored and sent on the wire: body plus envelope. */
export type SessionEvent = SessionEventBody & {
  seq: number;
  ts: number;
  sessionId: string;
};

export function truncateText(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return {
    text: text.slice(0, max) + `\n… [truncated ${text.length - max} characters]`,
    truncated: true,
  };
}
