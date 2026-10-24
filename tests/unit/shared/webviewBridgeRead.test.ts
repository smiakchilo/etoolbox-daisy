import { describe, expect, it } from 'vitest';
import {
  DOM_READ_MAX_ITEMS,
  webviewBridgeReadCommandSchema,
  webviewBridgeReplySchema,
} from '../../../src/shared/contracts/webviewBridge';

describe('webviewBridgeReadCommandSchema', () => {
  it('accepts a minimal read and one with every option', () => {
    expect(
      webviewBridgeReadCommandSchema.safeParse({ requestId: 'r', selector: 'a', limit: 1 }).success,
    ).toBe(true);
    expect(
      webviewBridgeReadCommandSchema.safeParse({
        requestId: 'r',
        selector: 'a',
        limit: DOM_READ_MAX_ITEMS,
        include: 'html',
        attributes: ['href', 'data-x'],
        frame: 'iframe#f',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['an empty selector', { selector: '' }],
    ['a limit of zero', { limit: 0 }],
    ['a limit above the cap', { limit: DOM_READ_MAX_ITEMS + 1 }],
    ['an unknown include', { include: 'script' }],
    ['an attribute name that is not a name', { attributes: ['on click'] }],
  ])('refuses %s', (_label, override) => {
    const command = { requestId: 'r', selector: 'a', limit: 1, ...override };
    expect(webviewBridgeReadCommandSchema.safeParse(command).success).toBe(false);
  });
});

describe('webviewBridgeReplySchema - dom replies', () => {
  const ok = {
    status: 'ok',
    url: 'https://x/',
    title: 't',
    matched: 1,
    items: [{ tag: 'a' }],
    truncated: false,
  };

  it.each([
    ['an ok result', ok],
    ['an invalid selector', { status: 'invalid_selector' }],
    ['an unavailable frame', { status: 'frame_unavailable' }],
  ])('accepts %s', (_label, result) => {
    expect(
      webviewBridgeReplySchema.safeParse({ kind: 'dom', requestId: 'r', result }).success,
    ).toBe(true);
  });

  it('refuses a result of an unknown status and an ok result without its counts', () => {
    expect(
      webviewBridgeReplySchema.safeParse({
        kind: 'dom',
        requestId: 'r',
        result: { status: 'weird' },
      }).success,
    ).toBe(false);
    expect(
      webviewBridgeReplySchema.safeParse({
        kind: 'dom',
        requestId: 'r',
        result: { status: 'ok', url: 'u', title: 't' },
      }).success,
    ).toBe(false);
  });
});
