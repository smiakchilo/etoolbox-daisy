import { describe, expect, it, vi } from 'vitest';
import { type DebuggerLike, DebuggerTransport } from '../pageAuditTransport';

type MessageListener = (event: unknown, method: string, params: unknown, sessionId: string) => void;

function fakeDebugger(sendCommand: DebuggerLike['sendCommand'] = () => Promise.resolve({})) {
  const listeners = new Set<MessageListener>();
  const api = {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(sendCommand),
    on: vi.fn((_event: 'message', listener: MessageListener) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((_event: 'message', listener: MessageListener) => {
      listeners.delete(listener);
    }),
  };
  return {
    api: api as unknown as DebuggerLike,
    mocks: api,
    emit: (method: string, params: unknown, sessionId = '') => {
      for (const listener of listeners) listener({}, method, params, sessionId);
    },
    listenerCount: () => listeners.size,
  };
}

function transportOver(debuggerApi: DebuggerLike) {
  const transport = new DebuggerTransport(debuggerApi, { title: 'T', url: 'https://x.example/' });
  const received: Record<string, unknown>[] = [];
  transport.onmessage = (message) => received.push(JSON.parse(message) as Record<string, unknown>);
  const next = async (count: number) => {
    await vi.waitFor(() => {
      expect(received.length).toBeGreaterThanOrEqual(count);
    });
    return received;
  };
  return { transport, received, next };
}

describe('DebuggerTransport', () => {
  it('attaches the debugger and listens for its events on construction', () => {
    const fake = fakeDebugger();

    transportOver(fake.api);

    expect(fake.mocks.attach).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount()).toBe(1);
  });

  it('answers the browser-level target conversation itself, announcing the page', async () => {
    const fake = fakeDebugger();
    const { transport, next } = transportOver(fake.api);

    transport.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    const messages = await next(2);

    expect(messages[0]).toMatchObject({ id: 1, result: {} });
    expect(messages[1]).toMatchObject({
      method: 'Target.attachedToTarget',
      params: { targetInfo: { type: 'page', url: 'https://x.example/', attached: true } },
    });
    expect(fake.mocks.sendCommand).not.toHaveBeenCalled();
  });

  it('refuses a browser-level command it does not know', async () => {
    const fake = fakeDebugger();
    const { transport, next } = transportOver(fake.api);

    transport.send(JSON.stringify({ id: 7, method: 'Browser.close' }));

    expect((await next(1))[0]).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it('forwards a session command to the debugger and returns its result', async () => {
    const fake = fakeDebugger(() => Promise.resolve({ value: 3 }));
    const { transport, next } = transportOver(fake.api);

    transport.send(
      JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression: '1+2' },
        sessionId: 'DAISY_ROOT_SESSION',
      }),
    );
    const messages = await next(1);

    expect(fake.mocks.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      { expression: '1+2' },
      undefined,
    );
    expect(messages[0]).toMatchObject({ id: 2, result: { value: 3 } });
  });

  it('turns a failing command into a protocol error', async () => {
    const fake = fakeDebugger(() => Promise.reject(new Error('gone')));
    const { transport, next } = transportOver(fake.api);

    transport.send(JSON.stringify({ id: 3, method: 'Page.reload', sessionId: 'other' }));

    expect((await next(1))[0]).toMatchObject({ id: 3, error: { message: 'gone' } });
    expect(fake.mocks.sendCommand).toHaveBeenCalledWith('Page.reload', {}, 'other');
  });

  it('relays debugger events, naming the root session when the debugger gave none', async () => {
    const fake = fakeDebugger();
    const { next } = transportOver(fake.api);

    fake.emit('Page.loadEventFired', { timestamp: 1 });
    fake.emit('Network.requestWillBeSent', {}, 'child');
    const messages = await next(2);

    expect(messages[0]).toMatchObject({
      method: 'Page.loadEventFired',
      sessionId: 'DAISY_ROOT_SESSION',
    });
    expect(messages[1]).toMatchObject({ method: 'Network.requestWillBeSent', sessionId: 'child' });
  });

  it('detaches once on close, stops listening and says it closed', () => {
    const fake = fakeDebugger();
    const { transport } = transportOver(fake.api);
    const onclose = vi.fn();
    transport.onclose = onclose;

    transport.close();
    transport.close();

    expect(fake.mocks.detach).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount()).toBe(0);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('survives a window that is already gone when it detaches', () => {
    const fake = fakeDebugger();
    fake.mocks.detach.mockImplementation(() => {
      throw new Error('destroyed');
    });
    const { transport } = transportOver(fake.api);

    expect(() => {
      transport.close();
    }).not.toThrow();
  });

  it('sends nothing after it closed', async () => {
    const fake = fakeDebugger();
    const { transport, received } = transportOver(fake.api);

    transport.close();
    transport.send(JSON.stringify({ id: 9, method: 'Target.getTargets' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(0);
  });
});
