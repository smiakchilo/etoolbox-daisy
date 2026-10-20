import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type ApplyPlan,
  buildMacScript,
  buildWindowsScript,
  macBundlePath,
} from '../../../../src/main/updates/applier';

const plan: ApplyPlan = {
  targetAsar: 'C:\\Apps\\Daisy\\resources\\app.asar',
  stagedAsar: 'C:\\Apps\\Daisy\\resources\\app.asar.new',
  pid: 4242,
  relaunchPath: 'C:\\Apps\\Daisy\\EToolbox Daisy.exe',
};

describe('buildWindowsScript', () => {
  it('waits for the pid, swaps keeping a backup, and relaunches', () => {
    const script = buildWindowsScript(plan);
    expect(script).toContain('set "PID=4242"');
    expect(script).toContain(`set "TARGET=${plan.targetAsar}"`);
    expect(script.indexOf(':wait')).toBeLessThan(script.indexOf('.bak'));
    expect(script).toContain('start "" "%EXE%"');
    expect(script.split('\r\n').length).toBeGreaterThan(10);
  });

  it('escapes percent signs so a path cannot expand variables', () => {
    const script = buildWindowsScript({ ...plan, targetAsar: 'C:\\100%\\app.asar' });
    expect(script).toContain('set "TARGET=C:\\100%%\\app.asar"');
  });
});

describe('buildMacScript', () => {
  const macPlan: ApplyPlan = {
    targetAsar: "/Applications/Daisy's.app/Contents/Resources/app.asar",
    stagedAsar: "/Applications/Daisy's.app/Contents/Resources/app.asar.new",
    pid: 77,
    relaunchPath: "/Applications/Daisy's.app",
  };

  it('single-quotes paths, escaping embedded quotes', () => {
    const script = buildMacScript(macPlan);
    expect(script).toContain(`'/Applications/Daisy'\\''s.app/Contents/Resources/app.asar'`);
    expect(script).toContain('PID=77');
  });

  it('clears quarantine and reopens the bundle', () => {
    const script = buildMacScript(macPlan);
    expect(script).toContain('xattr -cr "$APP"');
    expect(script).toContain('open "$APP"');
  });
});

describe('macBundlePath', () => {
  it('resolves the bundle three levels above the archive', () => {
    expect(macBundlePath(path.join('/a', 'X.app', 'Contents', 'Resources', 'app.asar'))).toBe(
      path.resolve('/a', 'X.app'),
    );
  });
});
