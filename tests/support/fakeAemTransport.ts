import {
  classifyStaleness,
  computeDeadline,
  isDeadlineExpired,
  toolRequestEnvelopeSchema,
  type Clock,
  type CurrentAemContext,
  type ToolRequestEnvelope,
} from '../../src/shared/contracts/toolContracts';
import { createToolError } from '../../src/shared/contracts/errors';
import {
  newMessageId,
  newRequestId,
  newToolCallId,
  type ChatId,
  type IdGenerator,
  type MessageId,
  type RequestId,
  type ToolCallId,
  type TurnId,
} from '../../src/shared/contracts/ids';
import {
  agentEventSchema,
  jsonValueSchema,
  EventSequencer,
  type AgentEvent,
  type SequenceCheckOutcome,
} from '../../src/shared/contracts/agentEvents';
import {
  applyAgentEvent,
  canRunAemTool,
  canSendMessage,
  type CanSendBlockReason,
  type IllegalTransitionError,
  type SessionStatus,
} from '../../src/shared/contracts/sessionState';
import {
  bumpRevision,
  type ServerConfig,
  type ServerTargetingChanges,
} from '../../src/shared/contracts/serverConfig';
import {
  serializeToolResult,
  toolResultSchema,
  type ToolErrorResult,
  type ToolResult,
} from '../../src/shared/contracts/toolResult';
import type { FakeAgentToolCall } from './fakeAgent';
import type { FakeBrowserSide } from './fakeBrowserSide';

/**
 * The fake main-process transport (implementation-plan.md step 03 success
 * criterion: contracts "successfully used by the fake agent/transport").
 *
 * This is the composition point: every decision it makes - argument
 * validation, policy gating, staleness/deadline handling, event sequencing,
 * session-state transition - is delegated to a function imported from
 * `src/shared/contracts`. Nothing here re-implements or shortcuts one of
 * those checks; if a contract turns out to be awkward to call correctly from
 * here, that is exactly the kind of mismatch this harness exists to surface.
 */

const DEFAULT_STATUS: SessionStatus = { state: 'idle', authenticated: true, browserReady: true };

export interface FakeMainTransportDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly browser: FakeBrowserSide;
  readonly server: ServerConfig;
}

export type StartTurnOutcome =
  | { readonly started: true; readonly messageId: MessageId }
  | { readonly started: false; readonly reason: CanSendBlockReason };

export type IssueToolCallOutcome =
  | {
      readonly kind: 'issued';
      readonly requestId: RequestId;
      readonly toolCallId: ToolCallId;
      readonly envelope: ToolRequestEnvelope;
      /**
       * Delivers the browser's answer. Deliberately a separate step from
       * issuing the call (rather than one synchronous/async round trip) so a
       * test can call `reconfigureServer`/`advanceNavigationEpoch` between
       * `issueToolCall` and `deliver()` and deterministically produce the
       * "request issued, then context changed, then a now-stale result
       * arrives" ordering - there is no other way to force that interleaving
       * without relying on real timers.
       */
      readonly deliver: () => ToolResult;
    }
  | {
      readonly kind: 'rejected';
      readonly requestId: RequestId;
      readonly toolCallId: ToolCallId;
      readonly result: ToolErrorResult;
    };

export class FakeMainTransport {
  private server: ServerConfig;
  private navigationEpoch = 0;
  private readonly sequencer = new EventSequencer();
  private readonly chatStatuses = new Map<ChatId, SessionStatus>();
  private readonly chatSequenceCounters = new Map<ChatId, number>();

  /** Every normalized event this transport has emitted, in emission order. */
  public readonly events: AgentEvent[] = [];
  /** Every illegal-transition report `applyAgentEvent` has produced, in order. */
  public readonly illegalTransitions: IllegalTransitionError[] = [];
  /** Every sequence-check outcome `EventSequencer` has produced, in order. */
  public readonly sequenceOutcomes: SequenceCheckOutcome[] = [];

  constructor(private readonly deps: FakeMainTransportDeps) {
    this.server = deps.server;
  }

  get currentServerRevision(): number {
    return this.server.revision;
  }

  get currentNavigationEpoch(): number {
    return this.navigationEpoch;
  }

  getChatStatus(chatId: ChatId): SessionStatus {
    return this.chatStatuses.get(chatId) ?? DEFAULT_STATUS;
  }

  /**
   * Seeds a chat's auth/browser-readiness directly, bypassing the event
   * stream. `sessionState.ts`'s module doc is explicit that these two fields
   * are set by "the part of the app that actually knows about it (auth flow,
   * browser navigation)" independently of normalized agent events - this is
   * that seam's test-side stand-in.
   */
  setChatStatus(chatId: ChatId, status: SessionStatus): void {
    this.chatStatuses.set(chatId, status);
  }

  /** Applies a targeting change to the configured server through the real `bumpRevision`. */
  reconfigureServer(changes: ServerTargetingChanges = {}): ServerConfig {
    this.server = bumpRevision(this.server, changes);
    return this.server;
  }

  /** Simulates the browser leaving (and not necessarily returning to) the page a request targeted. */
  advanceNavigationEpoch(): number {
    this.navigationEpoch += 1;
    return this.navigationEpoch;
  }

  /**
   * Feeds a hand-crafted `AgentEvent` through the same sequencing/session
   * -state machinery real events go through, without any of `issueToolCall`'s
   * argument validation. Exists so a test can inject a duplicate or
   * out-of-order delivery that this transport's own monotonic per-chat
   * counter would never itself produce.
   */
  ingestRawEvent(event: AgentEvent): SequenceCheckOutcome {
    return this.record(event);
  }

  /** Begins a turn (`idle -> sending -> streaming`), gated by `canSendMessage`. */
  startTurn(chatId: ChatId, turnId: TurnId): StartTurnOutcome {
    const gate = canSendMessage(this.getChatStatus(chatId));
    if (!gate.canSend) {
      return { started: false, reason: gate.reason };
    }
    this.record({
      type: 'session.state.changed',
      chatId,
      sequence: this.nextSequence(chatId),
      turnId,
      state: 'sending',
    });
    const messageId = newMessageId(this.deps.idGenerator);
    this.record({
      type: 'assistant.message.started',
      chatId,
      sequence: this.nextSequence(chatId),
      turnId,
      messageId,
    });
    return { started: true, messageId };
  }

  /** Ends a turn (`streaming -> idle`) once the assistant's final message is ready. */
  completeTurn(chatId: ChatId, turnId: TurnId, messageId: MessageId, content: string): void {
    this.record({
      type: 'assistant.message.completed',
      chatId,
      sequence: this.nextSequence(chatId),
      turnId,
      messageId,
      content,
    });
    this.record({
      type: 'session.state.changed',
      chatId,
      sequence: this.nextSequence(chatId),
      turnId,
      state: 'idle',
    });
  }

  /**
   * Issues one agent-originated tool call. Validates `call.args` by building
   * the same `ToolRequestEnvelope` the real main process would build (main
   * attaches `requestId`/`chatId`/`turnId`/`serverId`/`serverRevision`/
   * `navigationEpoch`/an absolute deadline - the agent never supplies any of
   * them), then gates on `canRunAemTool` before ever contacting the browser.
   */
  issueToolCall(params: {
    readonly chatId: ChatId;
    readonly turnId: TurnId;
    readonly call: FakeAgentToolCall;
  }): IssueToolCallOutcome {
    const { chatId, turnId, call } = params;
    const requestId = newRequestId(this.deps.idGenerator);
    const toolCallId = newToolCallId(this.deps.idGenerator);

    this.record({
      type: 'tool.call.requested',
      chatId,
      sequence: this.nextSequence(chatId),
      toolCallId,
      toolName: call.operation,
      arguments: call.args,
    });

    const candidate = {
      operation: call.operation,
      requestId,
      chatId,
      turnId,
      serverId: this.server.id,
      serverRevision: this.server.revision,
      navigationEpoch: this.navigationEpoch,
      deadlineMs: computeDeadline(this.deps.clock),
      args: call.args,
    };
    const parsedEnvelope = toolRequestEnvelopeSchema.safeParse(candidate);

    if (!parsedEnvelope.success) {
      const message =
        parsedEnvelope.error.issues[0]?.message ?? 'the tool arguments failed validation';
      const result: ToolErrorResult = {
        ok: false,
        error: createToolError('INVALID_ARGUMENT', message, requestId),
      };
      this.record({
        type: 'tool.call.rejected',
        chatId,
        sequence: this.nextSequence(chatId),
        toolCallId,
        reason: message,
      });
      return { kind: 'rejected', requestId, toolCallId, result };
    }

    const envelope = parsedEnvelope.data;
    const gate = canRunAemTool(this.getChatStatus(chatId));
    if (!gate.canRun) {
      const message = `AEM tool blocked: ${gate.reason}`;
      const result: ToolErrorResult = {
        ok: false,
        error: createToolError('ACCESS_DENIED', message, requestId),
      };
      this.record({
        type: 'tool.call.rejected',
        chatId,
        sequence: this.nextSequence(chatId),
        toolCallId,
        reason: message,
      });
      return { kind: 'rejected', requestId, toolCallId, result };
    }

    this.record({
      type: 'tool.call.approved',
      chatId,
      sequence: this.nextSequence(chatId),
      toolCallId,
    });

    const deliver = (): ToolResult => {
      const result = this.resolve(envelope);
      const sequence = this.nextSequence(chatId);
      this.record(
        result.ok
          ? {
              type: 'tool.result',
              chatId,
              sequence,
              toolCallId,
              outcome: {
                ok: true,
                data: jsonValueSchema.parse(JSON.parse(serializeToolResult(result))),
              },
            }
          : {
              type: 'tool.result',
              chatId,
              sequence,
              toolCallId,
              outcome: { ok: false, error: result.error },
            },
      );
      return result;
    };

    return { kind: 'issued', requestId, toolCallId, envelope, deliver };
  }

  /**
   * Resolves an already-validated envelope against the fake browser, gating
   * on the deadline and on staleness first. Order matters:
   * `implementation-plan.md`'s "never return `[]` in place of an error" is
   * about the query result shape, but the same discipline applies here - a
   * result that arrives after the deadline or after the context moved on
   * must never quietly become a normal success just because the browser
   * happened to answer.
   */
  private resolve(envelope: ToolRequestEnvelope): ToolResult {
    if (isDeadlineExpired(envelope.deadlineMs, this.deps.clock)) {
      return {
        ok: false,
        error: createToolError(
          'TIMEOUT',
          'The AEM request exceeded its 90-second deadline before a result arrived.',
          envelope.requestId,
        ),
      };
    }

    const current: CurrentAemContext = {
      serverRevision: this.server.revision,
      navigationEpoch: this.navigationEpoch,
    };
    const staleness = classifyStaleness(envelope, current);
    if (staleness !== 'fresh') {
      return {
        ok: false,
        error: createToolError(
          'STALE_CONTEXT',
          `The AEM request context changed (${staleness}) before a result arrived; the ` +
            'stale result is discarded rather than shown to the model.',
          envelope.requestId,
        ),
      };
    }

    // Round-tripped through JSON to stand in for the envelope actually
    // crossing an IPC boundary, so the browser side re-parses plain data -
    // not a shared object reference it could trust without re-validating.
    const wireEnvelope: unknown = JSON.parse(JSON.stringify(envelope));
    const browserOutcome = this.deps.browser.handle(wireEnvelope);
    if (!browserOutcome.ok) {
      return {
        ok: false,
        error: createToolError(browserOutcome.code, browserOutcome.message, envelope.requestId),
      };
    }
    // Defense in depth: the final result main hands back must itself satisfy
    // the same schema the model-facing renderer and the IPC round trip rely on.
    return toolResultSchema.parse(browserOutcome.success);
  }

  private nextSequence(chatId: ChatId): number {
    const next = this.chatSequenceCounters.get(chatId) ?? 0;
    this.chatSequenceCounters.set(chatId, next + 1);
    return next;
  }

  private record(event: AgentEvent): SequenceCheckOutcome {
    // Re-validates every event this transport builds against the real schema
    // before doing anything else with it: a malformed event this harness
    // constructed incorrectly must surface as a thrown defect here, not
    // silently reach the sequencer/session-state machinery below.
    agentEventSchema.parse(event);
    const outcome = this.sequencer.check(event);
    this.sequenceOutcomes.push(outcome);
    this.events.push(event);

    const status = this.getChatStatus(event.chatId);
    const applied = applyAgentEvent(status, event);
    if (applied.ok) {
      this.chatStatuses.set(event.chatId, applied.value);
    } else {
      this.illegalTransitions.push(applied.error);
    }
    return outcome;
  }
}
