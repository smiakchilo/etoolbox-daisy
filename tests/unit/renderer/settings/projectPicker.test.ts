import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_DEFAULT_VALUE,
  createProjectPicker,
} from '../../../../src/renderer/src/settings/projectPicker';
import { newProjectId } from '../../../../src/shared';
import { projectSnapshot as snapshot } from '../../../support/configFixtures';
import { installJsdomGlobals } from '../../../support/jsdomGlobals';

let dom: JSDOM;
let restoreGlobals: () => void;

function menuLabels(picker: HTMLElement): string[] {
  return [...picker.querySelectorAll('sp-menu-item')].map((item) => item.textContent ?? '');
}

function menuValues(picker: HTMLElement): string[] {
  return [...picker.querySelectorAll('sp-menu-item')].map(
    (item) => item.getAttribute('value') ?? '',
  );
}

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
});

afterEach(() => {
  restoreGlobals();
});

describe('createProjectPicker', () => {
  it('offers the default entry before one option per project, and selects the stored id', () => {
    const picker = createProjectPicker({
      fieldId: 'project',
      initial: { kind: 'project', projectId: newProjectId(() => 'project-a') },
      projects: [snapshot('project-a', 'HPE'), snapshot('project-b', 'Acme')],
      onChange: () => undefined,
    });

    expect(menuValues(picker.element)).toEqual([
      PROJECT_DEFAULT_VALUE,
      newProjectId(() => 'project-a'),
      newProjectId(() => 'project-b'),
    ]);
    expect((picker.element as HTMLElement & { value: string }).value).toBe(
      newProjectId(() => 'project-a'),
    );
  });

  it('reads a change as the project selection and fires onChange', () => {
    const onChange = vi.fn();
    const picker = createProjectPicker({
      fieldId: 'project',
      initial: { kind: 'default' },
      projects: [snapshot('project-a', 'HPE')],
      onChange,
    });

    const element = picker.element as HTMLElement & { value: string };
    element.value = newProjectId(() => 'project-a');
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(picker.read()).toEqual({ kind: 'project', projectId: newProjectId(() => 'project-a') });

    element.value = PROJECT_DEFAULT_VALUE;
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(picker.read()).toEqual({ kind: 'default' });
  });

  it('repairs a stored id that no longer exists to "(Default)"', () => {
    const picker = createProjectPicker({
      fieldId: 'project',
      initial: { kind: 'project', projectId: newProjectId(() => 'project-gone') },
      projects: [snapshot('project-a', 'HPE')],
      onChange: () => undefined,
    });

    expect(picker.read()).toEqual({ kind: 'default' });
    expect((picker.element as HTMLElement & { value: string }).value).toBe(PROJECT_DEFAULT_VALUE);
  });

  it('repairs the selection when setOptions removes the selected entry', () => {
    const picker = createProjectPicker({
      fieldId: 'project',
      initial: { kind: 'project', projectId: newProjectId(() => 'project-a') },
      projects: [snapshot('project-a', 'HPE')],
      onChange: () => undefined,
    });

    picker.setOptions([snapshot('project-b', 'Acme')]);

    expect(picker.read()).toEqual({ kind: 'default' });
    expect(menuValues(picker.element)[0]).toBe(PROJECT_DEFAULT_VALUE);
    expect(menuLabels(picker.element).slice(1)).toEqual(['Acme']);
  });
});
