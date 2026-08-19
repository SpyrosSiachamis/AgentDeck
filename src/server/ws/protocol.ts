import { z } from 'zod';
import type { SessionEvent } from '../sessions/events.js';
import type { SessionSummary } from '../sessions/session.js';
import type { PublicWorkspace } from '../workspaces.js';
import type { AdapterDescriptor } from '../adapters/types.js';

/** Every inbound frame is validated before it can touch session state. */
export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ping') }),
  z.object({
    t: z.literal('subscribe'),
    sessionId: z.string().min(1).max(64),
    sinceSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  }),
  z.object({ t: z.literal('unsubscribe'), sessionId: z.string().min(1).max(64) }),
  z.object({
    t: z.literal('instruct'),
    sessionId: z.string().min(1).max(64),
    text: z.string().min(1),
    clientMsgId: z.string().min(1).max(64).optional(),
  }),
  z.object({ t: z.literal('cancel'), sessionId: z.string().min(1).max(64) }),
  z.object({
    t: z.literal('permission'),
    sessionId: z.string().min(1).max(64),
    requestId: z.string().min(1).max(128),
    decision: z.enum(['allow', 'deny']),
    reason: z.string().max(500).optional(),
  }),
  z.object({ t: z.literal('list_sessions') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | {
      t: 'welcome';
      identity: { login: string | null; displayName: string | null; viaTailscale: boolean };
      workspaces: PublicWorkspace[];
      agents: AdapterDescriptor[];
      defaultAgent: string;
      sessions: SessionSummary[];
      limits: { maxConcurrentSessions: number; maxInstructionChars: number };
      serverTime: number;
    }
  | { t: 'pong'; serverTime: number }
  | { t: 'events'; sessionId: string; events: SessionEvent[] }
  | { t: 'session'; session: SessionSummary }
  | { t: 'sessions'; sessions: SessionSummary[] }
  | { t: 'subscribed'; sessionId: string; lastSeq: number; gapSkipped: number }
  | { t: 'ack'; clientMsgId?: string; sessionId: string; instructionId: string }
  | { t: 'error'; code: string; message: string; sessionId?: string; clientMsgId?: string };
