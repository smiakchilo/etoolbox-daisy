import type { ConnectionTransport } from 'puppeteer-core';

/**
 * The part of Electron's `webContents.debugger` the transport needs. Declared
 * structurally so the transport can be driven by a fake in a unit test.
 */
export interface DebuggerLike {
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void,
  ): unknown;
  removeListener(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void,
  ): unknown;
}

export interface TransportTarget {
  readonly title: string;
  readonly url: string;
}

const ROOT_SESSION = 'DAISY_ROOT_SESSION';
const TARGET_ID = 'DAISY_AUDIT_TARGET';
const METHOD_NOT_FOUND = -32601;
const COMMAND_FAILED = -32000;

interface ProtocolMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

/**
 * Lets puppeteer drive one `WebContents` through its in-process debugger, with
 * no remote-debugging port: the page is the only target, so the browser-level
 * `Target.*` conversation puppeteer opens with is answered here, and every
 * other command goes to `webContents.debugger` unchanged.
 */
export class DebuggerTransport implements ConnectionTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;

  private closed = false;
  private readonly targetInfo: Record<string, unknown>;
  private readonly forward = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId: string,
  ): void => {
    this.emit({ method, params, sessionId: sessionId || ROOT_SESSION });
  };

  constructor(
    private readonly debuggerApi: DebuggerLike,
    target: TransportTarget,
  ) {
    this.targetInfo = {
      targetId: TARGET_ID,
      type: 'page',
      title: target.title,
      url: target.url,
      attached: false,
      canAccessOpener: false,
    };
    debuggerApi.attach('1.3');
    debuggerApi.on('message', this.forward);
  }

  send(raw: string): void {
    if (this.closed) return;
    const message = JSON.parse(raw) as ProtocolMessage;
    const { id, method, params, sessionId } = message;
    if (id === undefined || method === undefined) return;
    if (sessionId === undefined) {
      this.answerBrowserCommand(id, method);
      return;
    }
    this.debuggerApi
      .sendCommand(method, params ?? {}, sessionId === ROOT_SESSION ? undefined : sessionId)
      .then(
        (result) => this.reply(id, result, sessionId),
        (error: unknown) =>
          this.emit({
            id,
            error: {
              code: COMMAND_FAILED,
              message: error instanceof Error ? error.message : String(error),
            },
            sessionId,
          }),
      );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.debuggerApi.removeListener('message', this.forward);
    try {
      this.debuggerApi.detach();
    } catch {
      // The window may already be gone; there is nothing left to detach from.
    }
    this.onclose?.();
  }

  private answerBrowserCommand(id: number, method: string): void {
    switch (method) {
      case 'Target.getBrowserContexts':
        this.reply(id, { browserContextIds: [] });
        return;
      case 'Target.setDiscoverTargets':
        this.reply(id, {});
        this.emit({ method: 'Target.targetCreated', params: { targetInfo: this.targetInfo } });
        return;
      case 'Target.setAutoAttach':
        this.reply(id, {});
        this.emit({
          method: 'Target.attachedToTarget',
          params: {
            sessionId: ROOT_SESSION,
            targetInfo: { ...this.targetInfo, attached: true },
            waitingForDebugger: false,
          },
        });
        return;
      case 'Target.attachToTarget':
        this.reply(id, { sessionId: ROOT_SESSION });
        return;
      case 'Target.getTargetInfo':
        this.reply(id, { targetInfo: this.targetInfo });
        return;
      case 'Target.getTargets':
        this.reply(id, { targetInfos: [this.targetInfo] });
        return;
      default:
        this.emit({ id, error: { code: METHOD_NOT_FOUND, message: `Unsupported ${method}` } });
    }
  }

  private reply(id: number, result: unknown, sessionId?: string): void {
    this.emit({ id, result: result ?? {}, ...(sessionId === undefined ? {} : { sessionId }) });
  }

  private emit(message: object): void {
    setImmediate(() => {
      if (!this.closed) this.onmessage?.(JSON.stringify(message));
    });
  }
}
