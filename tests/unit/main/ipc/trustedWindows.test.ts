import { describe, expect, it } from 'vitest';
import { createTrustedWindowRegistry } from '../../../../src/main/ipc/trustedWindows';

describe('createTrustedWindowRegistry', () => {
  it('trusts nothing by default', () => {
    const registry = createTrustedWindowRegistry();
    expect(registry.has(1)).toBe(false);
  });

  it('trusts the ids it was seeded with', () => {
    const registry = createTrustedWindowRegistry([7]);
    expect(registry.has(7)).toBe(true);
    expect(registry.has(8)).toBe(false);
  });

  it('trusts a window added after construction', () => {
    const registry = createTrustedWindowRegistry([7]);
    expect(registry.has(9)).toBe(false);
    registry.add(9);
    expect(registry.has(9)).toBe(true);
    // Adding must not disturb existing membership.
    expect(registry.has(7)).toBe(true);
  });

  it('stops trusting a removed window', () => {
    const registry = createTrustedWindowRegistry([7]);
    registry.add(9);
    registry.remove(9);
    expect(registry.has(9)).toBe(false);
    expect(registry.has(7)).toBe(true);
  });

  it('ignores removal of an id it never trusted', () => {
    const registry = createTrustedWindowRegistry([7]);
    registry.remove(123);
    expect(registry.has(7)).toBe(true);
  });
});
