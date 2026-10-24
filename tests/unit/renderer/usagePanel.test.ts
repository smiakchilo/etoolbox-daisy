import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRow } from '../../../src/renderer/src/chat/sessionUsage';
import { createUsagePanel } from '../../../src/renderer/src/shell/usagePanel';
import { installJsdomGlobals } from '../../support/jsdomGlobals';
import { byTestId } from '../../support/selectors';

let dom: JSDOM;
let restoreGlobals: () => void;

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
});

afterEach(() => {
  restoreGlobals();
});

// noinspection HtmlRequiredAltAttribute,HtmlUnknownTarget,HtmlDeprecatedAttribute
const ROWS: readonly UsageRow[] = [
  { id: 'model', label: 'Model', value: 'gpt-x' },
  { id: 'output', label: 'Output', value: '<img src=x onerror=alert(1)>' },
];

describe('createUsagePanel', () => {
  it('starts hidden and opens and closes like the other whole-size panels', () => {
    const panel = createUsagePanel({ onDismiss: vi.fn() });

    expect(panel.element.hidden).toBe(true);
    panel.open();
    expect(panel.isOpen).toBe(true);
    expect(panel.element.hidden).toBe(false);
    panel.close();
    expect(panel.element.hidden).toBe(true);
    panel.dispose();
  });

  it('draws one row per entry, each findable by its id', () => {
    const panel = createUsagePanel({ onDismiss: vi.fn() });

    panel.setRows(ROWS);

    expect(panel.element.querySelectorAll('.usage-row')).toHaveLength(2);
    expect(panel.element.querySelector(byTestId('usage-row-model'))?.textContent).toContain(
      'gpt-x',
    );
    panel.dispose();
  });

  it('draws values as text, never as markup', () => {
    const panel = createUsagePanel({ onDismiss: vi.fn() });

    panel.setRows(ROWS);

    expect(panel.element.querySelector('img')).toBeNull();
    expect(panel.element.querySelector(byTestId('usage-row-output'))?.textContent).toContain(
      '<img',
    );
    panel.dispose();
  });

  it('leaves its rows alone when they are unchanged, and replaces them when they change', () => {
    const panel = createUsagePanel({ onDismiss: vi.fn() });
    panel.setRows(ROWS);
    const first = panel.element.querySelector('.usage-row');

    panel.setRows([...ROWS]);
    expect(panel.element.querySelector('.usage-row')).toBe(first);

    panel.setRows([{ id: 'model', label: 'Model', value: 'other' }]);
    expect(panel.element.querySelectorAll('.usage-row')).toHaveLength(1);
    expect(panel.element.querySelector(byTestId('usage-row-model'))?.textContent).toContain(
      'other',
    );
    panel.dispose();
  });

  it('reports a dismissal from its close button and from Escape', () => {
    const onDismiss = vi.fn();
    const panel = createUsagePanel({ onDismiss });
    panel.open();

    panel.element
      .querySelector(byTestId('usage-panel-close'))
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    panel.open();
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onDismiss).toHaveBeenCalledTimes(2);
    panel.dispose();
  });
});
