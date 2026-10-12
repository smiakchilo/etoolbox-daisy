import { el } from '../lib/dom';
import type { ProjectId, ProjectSnapshot } from '../../../shared';
import { syncPickerOptions, type PickerLike } from './pickerOptions';

/** Picker sentinel for "(Default)" - no project, so the default roots apply. */
export const PROJECT_DEFAULT_VALUE = '__default__';

/**
 * What the Project picker currently shows. A discriminated union rather than a
 * bare id-or-`undefined`, mirroring `ProxySelection`: "(Default)" (no project)
 * and a specific project are two distinct states, and only the latter carries
 * an id.
 */
export type ProjectSelection =
  { readonly kind: 'default' } | { readonly kind: 'project'; readonly projectId: ProjectId };

export interface ProjectPickerHandle {
  readonly element: HTMLElement;
  /** The current selection. */
  read(): ProjectSelection;
  /** Rebuilds the options from the current project library, keeping/repairing the selection. */
  setOptions(projects: readonly ProjectSnapshot[]): void;
  /** Sets the selection from stored state, repairing a dangling id. */
  select(selection: ProjectSelection): void;
}

export interface CreateProjectPickerOptions {
  /** Id for the picker, so an external `<sp-field-label for="...">` can label it. */
  readonly fieldId: string;
  /** The stored selection; a dangling id is repaired to "(Default)". */
  readonly initial: ProjectSelection;
  readonly projects: readonly ProjectSnapshot[];
  readonly onChange: () => void;
}

function valueFromSelection(selection: ProjectSelection): string {
  return selection.kind === 'default' ? PROJECT_DEFAULT_VALUE : selection.projectId;
}

function selectionFromValue(value: string): ProjectSelection {
  if (value === PROJECT_DEFAULT_VALUE) return { kind: 'default' };
  return { kind: 'project', projectId: value as ProjectId };
}

/**
 * The Project combobox: an `sp-picker` whose items are "(Default)" plus one per
 * entry of the settings "Projects" library. It *displays* each entry's label but
 * *stores and returns* its id - the caller never persists a label.
 *
 * The options are re-derived from the live library on every
 * {@link ProjectPickerHandle.setOptions}, so an add/rename/remove on the
 * Projects tab is reflected here. A selection whose entry no longer exists is
 * repaired to "(Default)" rather than left pointing at a missing id (main also
 * clears the dangling reference in the same write; see `removeProject`).
 */
export function createProjectPicker(options: CreateProjectPickerOptions): ProjectPickerHandle {
  const picker = el('sp-picker', {
    attrs: {
      id: options.fieldId,
      class: 'host-field__input project-picker',
      'aria-label': 'Project',
    },
  }) as PickerLike;

  let projects = options.projects;
  let selected: ProjectSelection = options.initial;

  function reconcile(selection: ProjectSelection): ProjectSelection {
    if (
      selection.kind === 'project' &&
      !projects.some((project) => project.id === selection.projectId)
    ) {
      return { kind: 'default' };
    }
    return selection;
  }

  function render(): void {
    syncPickerOptions(
      picker,
      [
        { value: PROJECT_DEFAULT_VALUE, label: '(Default)' },
        ...projects.map((project) => ({ value: project.id, label: project.label })),
      ],
      valueFromSelection(selected),
    );
  }

  selected = reconcile(selected);
  render();

  picker.addEventListener('change', () => {
    selected = selectionFromValue(picker.value);
    options.onChange();
  });

  return {
    element: picker,
    read(): ProjectSelection {
      return selected;
    },
    setOptions(next): void {
      projects = next;
      selected = reconcile(selected);
      render();
    },
    select(selection): void {
      selected = reconcile(selection);
      render();
    },
  };
}
