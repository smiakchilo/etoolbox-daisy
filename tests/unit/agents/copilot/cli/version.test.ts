import { describe, expect, it } from 'vitest';
import {
  compareCliVersions,
  isSupportedCliVersion,
  parseCliVersion,
} from '../../../../../src/agents/copilot/cli/version';

/**
 * A version is read from the binary's own answer, never guessed from a file
 * name - so the parser is the one place a wrong number could enter the system.
 */

describe('parseCliVersion', () => {
  it('reads the version the CLI prints', () => {
    expect(parseCliVersion('GitHub Copilot CLI 1.0.103.')).toBe('1.0.103');
  });

  it('finds it among other lines, on stdout or stderr', () => {
    expect(parseCliVersion('checking for updates\nGitHub Copilot CLI 1.0.83\nready\n')).toBe(
      '1.0.83',
    );
  });

  it('refuses an answer with no three-part version', () => {
    expect(parseCliVersion('')).toBeUndefined();
    expect(parseCliVersion('command not found')).toBeUndefined();
    expect(parseCliVersion('version 1.0')).toBeUndefined();
  });

  it('does not take a two-part number for a version', () => {
    expect(parseCliVersion('Error: ENOENT 1.2')).toBeUndefined();
  });
});

describe('compareCliVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareCliVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareCliVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareCliVersions('1.0.83', '1.0.103')).toBeLessThan(0);
    expect(compareCliVersions('1.0.83', '1.0.83')).toBe(0);
  });
});

describe('isSupportedCliVersion', () => {
  it('accepts the floor and anything newer, and nothing older', () => {
    expect(isSupportedCliVersion('1.0.83', '1.0.83')).toBe(true);
    expect(isSupportedCliVersion('1.0.103', '1.0.83')).toBe(true);
    expect(isSupportedCliVersion('1.0.60', '1.0.83')).toBe(false);
    expect(isSupportedCliVersion('0.9.9', '1.0.83')).toBe(false);
  });
});
