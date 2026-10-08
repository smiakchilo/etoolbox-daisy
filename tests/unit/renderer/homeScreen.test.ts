import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeScreen } from '../../../src/renderer/src/shell/homeScreen';

/**
 * The pane's home (welcome) screen: the base layer that keeps the left pane
 * from ever being blank. These tests cover the pure content contract - the
 * app-info/skill fill and the zero-host affordance - with the pane-level
 * visibility and action wiring covered in `browserPane.test.ts`.
 */

let dom: JSDOM;

const previousDocument = Reflect.get(globalThis, 'document') as unknown;

beforeEach(() => {
  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
});

function build(): ReturnType<typeof createHomeScreen> {
  return createHomeScreen({ onOpenHosts: vi.fn(), onOpenSettings: vi.fn() });
}

describe('createHomeScreen', () => {
  it('starts with a static name and a loading tools row, before any IPC', () => {
    const home = build();
    expect(home.element.querySelector('.browser-home__name')?.textContent).toBe('EToolbox Daisy');
    expect(home.element.querySelector<HTMLElement>('.browser-home__version')?.hidden).toBe(true);
    expect(home.element.querySelector('.browser-home__skills-status')?.textContent).toBe(
      'Loading tools\u2026',
    );
  });

  it('has a "Useful tools" heading and no intro paragraph', () => {
    const home = build();
    expect(home.element.querySelector('.browser-home__section-title')?.textContent).toBe(
      'Useful tools',
    );
    expect(home.element.querySelector('.browser-home__intro')).toBeNull();
  });

  it('fills the real app name and version', () => {
    const home = build();
    home.setAppInfo({ name: 'EToolbox Daisy', version: '2.3.4', apiVersion: 1 });
    expect(home.element.querySelector('.browser-home__name')?.textContent).toBe('EToolbox Daisy');
    const version = home.element.querySelector<HTMLElement>('.browser-home__version');
    expect(version?.hidden).toBe(false);
    expect(version?.textContent).toBe('Version 2.3.4');
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
    expect(status?.textContent).toBe('No user-invocable tools are installed.');
    expect(home.element.querySelector<HTMLElement>('.browser-home__skill-list')?.hidden).toBe(true);
  });

  it('disables "Select a host" when no hosts are available', () => {
    const home = build();
    const hostsAction = home.element.querySelector<HTMLElement>('.browser-home__action');
    expect(hostsAction?.textContent).toBe('Select a host');
    home.setHostsAvailable(false);
    expect(hostsAction?.hasAttribute('disabled')).toBe(true);
    home.setHostsAvailable(true);
    expect(hostsAction?.hasAttribute('disabled')).toBe(false);
  });
});
