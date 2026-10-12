import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_DEFAULT_VALUE,
  createProjectPicker,
} from '../../../../src/renderer/src/settings/projectPicker';
import { newProjectId, projectSnapshotSchema, type ProjectSnapshot } from '../../../../src/shared';

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;

function snapshot(id: string, label: string): ProjectSnapshot {
  return projectSnapshotSchema.parse({ id: newProjectId(() => id), label });
}

function menuLabels(picker: HTMLElement): string[] {
  return [...picker.querySelectorAll('sp-menu-item')].map((item) => item.textContent ?? '');
}

function menuValues(picker: HTMLElement): string[] {
  return [...picker.querySelectorAll('sp-menu-item')].map(
    (item) => item.getAttribute('value') ?? '',
  );
}

beforeEach(() => {
  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

describe('createProjectPicker', () => {
  it('offers "(Default)" before one option per project, and selects the stored id', () => {
    const picker = createProjectPicker({
      fieldId: 'project',
      initial: { kind: 'project', projectId: newProjectId(() => 'project-a') },
      projects: [snapshot('project-a', 'HPE'), snapshot('project-b', 'Acme')],
      onChange: () => undefined,
    });

    expect(menuLabels(picker.element)).toEqual(['(Default)', 'HPE', 'Acme']);
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
    expect(menuLabels(picker.element)).toEqual(['(Default)', 'Acme']);
  });
});
