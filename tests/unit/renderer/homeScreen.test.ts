import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveShortcut } from '../../../src/main/shortcuts';
import { createHomeScreen, HOME_SHORTCUTS } from '../../../src/renderer/src/shell/homeScreen';
import { makeInput } from '../../support/electronInput';
import { installJsdomGlobals } from '../../support/jsdomGlobals';

/**
 * The pane's home (welcome) screen: the base layer that keeps the left pane
 * from ever being blank. These tests cover the pure content contract - the
 * app-info/skill fill and the zero-host affordance - with the pane-level
 * visibility and action wiring covered in `browserPane.test.ts`.
 */

let restoreGlobals: () => void;

beforeEach(() => {
  ({ restore: restoreGlobals } = installJsdomGlobals({ exposeWindow: false }));
});

afterEach(() => {
  restoreGlobals();
});

function build(): ReturnType<typeof createHomeScreen> {
  return createHomeScreen({
    onOpenHosts: vi.fn(),
    onOpenHistory: vi.fn(),
    onOpenSettings: vi.fn(),
    onClose: vi.fn(),
  });
}

describe('createHomeScreen', () => {
  it('starts with a static name and a loading commands row, before any IPC', () => {
    const home = build();
    expect(home.element.querySelector('.browser-home__name')?.textContent).toBeTruthy();
    expect(home.element.querySelector<HTMLElement>('.browser-home__version')?.hidden).toBe(true);
    expect(home.element.querySelector('.browser-home__skills-status')?.textContent).toBeTruthy();
  });

  it('fills the real app name and version', () => {
    const home = build();
    home.setAppInfo({ name: 'EToolbox Daisy', version: '2.3.4', apiVersion: 1 });
    expect(home.element.querySelector('.browser-home__name')?.textContent).toBe('EToolbox Daisy');
    const version = home.element.querySelector<HTMLElement>('.browser-home__version');
    expect(version?.hidden).toBe(false);
    expect(version?.textContent).toContain('2.3.4');
  });

  it('lists the skills it is handed, each prefixed with a slash', () => {
    const home = build();
    home.setSkills([{ name: 'search', description: 'Find content' }]);
    expect(home.element.querySelector('.browser-home__skill-name')?.textContent).toBe('/search');
    expect(home.element.querySelector('.browser-home__skill-description')?.textContent).toBe(
      'Find content',
    );
    expect(home.element.querySelector<HTMLElement>('.browser-home__skills-status')?.hidden).toBe(
      true,
    );
  });

  it('shows an honest empty state when the catalogue has no user-invocable skills', () => {
    const home = build();
    home.setSkills([]);
    const status = home.element.querySelector<HTMLElement>('.browser-home__skills-status');
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toBeTruthy();
    expect(home.element.querySelector<HTMLElement>('.browser-home__skill-list')?.hidden).toBe(true);
  });

  it('disables the hosts action when no hosts are available', () => {
    const home = build();
    const hostsAction = home.element.querySelector<HTMLElement>('.browser-home__action');
    expect(hostsAction).not.toBeNull();
    home.setHostsAvailable(false);
    expect(hostsAction?.hasAttribute('disabled')).toBe(true);
    home.setHostsAvailable(true);
    expect(hostsAction?.hasAttribute('disabled')).toBe(false);
  });

  it('offers hosts, history and settings actions, firing each', () => {
    const onOpenHistory = vi.fn();
    const onOpenSettings = vi.fn();
    const home = createHomeScreen({
      onOpenHosts: vi.fn(),
      onOpenHistory,
      onOpenSettings,
      onClose: vi.fn(),
    });
    const actions = [...home.element.querySelectorAll<HTMLElement>('.browser-home__action')];
    expect(actions).toHaveLength(3);

    actions[1]?.click();
    actions[2]?.click();
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('offers the close control only while forced over a page, and fires onClose', () => {
    const onClose = vi.fn();
    const home = createHomeScreen({
      onOpenHosts: vi.fn(),
      onOpenHistory: vi.fn(),
      onOpenSettings: vi.fn(),
      onClose,
    });
    const close = home.element.querySelector<HTMLElement>('.browser-home__close');
    if (!close) throw new Error('close control not found');

    // The genuine empty state: nothing to close.
    expect(close.hidden).toBe(true);

    home.setClosable(true);
    expect(close.hidden).toBe(false);
    close.click();
    expect(onClose).toHaveBeenCalledTimes(1);

    home.setClosable(false);
    expect(close.hidden).toBe(true);
  });

  it('renders one Shortcuts row per advertised keystroke, each with a key and a description', () => {
    const home = build();
    const rows = [...home.element.querySelectorAll<HTMLElement>('.browser-home__shortcut')];
    expect(rows).toHaveLength(HOME_SHORTCUTS.length);
    for (const row of rows) {
      expect(row.querySelector('.browser-home__shortcut-keys')?.textContent).toBeTruthy();
      expect(row.querySelector('.browser-home__shortcut-description')?.textContent).toBeTruthy();
    }
  });
});

describe('HOME_SHORTCUTS', () => {
  /**
   * The home screen's "Shortcuts" section is hand-maintained prose, so AGENTS.md
   * requires it to be revised whenever a shortcut changes. This makes that rule
   * enforceable: every keystroke it advertises must be one the app's own key map
   * (`resolveShortcut`, `src/main/shortcuts.ts`) actually claims - a rebind or a
   * removal that the list was not updated for fails here instead of shipping a
   * dead hint.
   */
  it('advertises only keystrokes the app actually claims', () => {
    for (const { keystrokes } of HOME_SHORTCUTS) {
      expect(keystrokes.length).toBeGreaterThan(0);
      for (const { code, key, control, alt, shift } of keystrokes) {
        const input = makeInput(code, {
          key: key ?? '',
          control: control ?? false,
          alt: alt ?? false,
          shift: shift ?? false,
        });
        expect(resolveShortcut(input)).not.toBeNull();
      }
    }
  });
});
