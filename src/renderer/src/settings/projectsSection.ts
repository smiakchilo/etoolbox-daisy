import { BANNER_ACTION_MARKER } from '../lib/alertBanner';
import { containsFocus, el } from '../lib/dom';
import { createMultifield } from '../lib/multifield';
import { type ProjectId, type ProjectSnapshot } from '../../../shared';
import { createCommitSaver } from './commitSaver';
import type { SaveOutcome, StatusBannerAction, StatusBannerSink } from './statusBanner';
import { validateProjectLabelInput } from './viewModel';

type TextField = HTMLElement & { value: string };

/** Everything a project item needs from the section (and, one level up, the panel). */
interface ProjectItemContext {
  status: StatusBannerSink;
  reportSave(outcome: Promise<SaveOutcome>): void;
  onSettingsChanged(): void;
  /** Removes the item's row from the multifield (after confirmation, for a saved project). */
  removeRow(key: string): void;
}

interface ProjectItemHandle {
  readonly key: string;
  /** The item's field block - the multifield's "slot" content. */
  readonly element: HTMLElement;
  /** The persisted project id, or `undefined` while this is an unsaved draft. */
  projectId(): ProjectId | undefined;
  /** Asks for removal (drafts remove immediately; saved projects arm the banner confirmation). */
  requestRemoval(): void;
  /** True while this item has unsaved input or an unconfirmed action pending. */
  isInProgress(): boolean;
  flushNow(): Promise<void>;
  dispose(): void;
}

function setInvalid(field: TextField, help: HTMLElement, message: string | undefined): void {
  if (message === undefined) {
    field.removeAttribute('invalid');
    help.textContent = '';
    return;
  }
  field.setAttribute('invalid', '');
  help.textContent = message;
}

function labelledField(fieldId: string, label: string, control: HTMLElement): HTMLElement {
  return el('div', {
    attrs: { class: 'host-field' },
    children: [el('sp-field-label', { attrs: { for: fieldId }, text: label }), control],
  });
}

/**
 * One project row - a draft (no `projectId`) or an existing library entry. Its
 * label and roots are editable in place and save with no Save button, but a
 * typed value is committed only when the field is left (`change`: blur or
 * Enter) - never on a pause in typing.
 *
 * Unlike a host's origin, a project has no targeting: nothing about reaching
 * AEM depends on it, so a commit applies immediately with no confirmation.
 *
 * A draft has no entry to target yet: its first *valid* commit calls
 * `settings:add-project`, and the entry is created at the end of the list (the
 * multifield only reorders already-persisted entries).
 */
function buildProjectItem(
  project: ProjectSnapshot | undefined,
  key: string,
  fieldIdBase: string,
  ctx: ProjectItemContext,
): ProjectItemHandle {
  const labelFieldId = `${fieldIdBase}-label`;
  const contentRootsFieldId = `${fieldIdBase}-content-roots`;
  const componentRootsFieldId = `${fieldIdBase}-component-roots`;
  const priorityPathsFieldId = `${fieldIdBase}-priority-paths`;
  const damRootsFieldId = `${fieldIdBase}-dam-roots`;

  const labelField = el('sp-textfield', {
    attrs: {
      id: labelFieldId,
      class: 'host-field__input',
      placeholder: 'Project name',
      'aria-label': 'Label',
    },
  }) as TextField;
  labelField.value = project?.label ?? '';
  const labelHelp = el('span', { attrs: { slot: 'negative-help-text' } });
  labelField.append(labelHelp);

  // Free-text root lists. Presentation, not targeting: they describe the hosts'
  // content/component/DAM layout for the agent and never bump a host revision.
  const contentRootsField = el('sp-textfield', {
    attrs: {
      id: contentRootsFieldId,
      class: 'host-field__input',
      placeholder: 'E.g. /content/a, /content/b (comma-separated)',
      'aria-label': 'Content roots',
    },
  }) as TextField;
  contentRootsField.value = project?.contentRoots ?? '';

  const componentRootsField = el('sp-textfield', {
    attrs: {
      id: componentRootsFieldId,
      class: 'host-field__input',
      placeholder: 'E.g. /apps/a, /apps/b (comma-separated)',
      'aria-label': 'Component roots',
    },
  }) as TextField;
  componentRootsField.value = project?.componentRoots ?? '';

  const priorityPathsField = el('sp-textfield', {
    attrs: {
      id: priorityPathsFieldId,
      class: 'host-field__input',
      placeholder: 'E.g.: /content/a/blueprint, /content/a/language/en (comma-separated)',
      'aria-label': 'Content priority paths',
    },
  }) as TextField;
  priorityPathsField.value = project?.contentPriorityPaths ?? '';

  // Where DAM assets live. A search composite (`/search`, `/semantic-search`)
  // also covers these roots, after the content roots.
  const damRootsField = el('sp-textfield', {
    attrs: {
      id: damRootsFieldId,
      class: 'host-field__input',
      placeholder: 'E.g.: /content/dam/a, /content/dam/b',
      'aria-label': 'DAM roots',
    },
  }) as TextField;
  damRootsField.value = project?.damRoots ?? '';

  const fields = el('div', {
    attrs: { class: 'host-item__fields' },
    children: [
      labelledField(labelFieldId, 'Label (required)', labelField),
      labelledField(componentRootsFieldId, 'Component roots', componentRootsField),
      labelledField(contentRootsFieldId, 'Content roots', contentRootsField),
      labelledField(priorityPathsFieldId, 'Content priority paths', priorityPathsField),
      labelledField(damRootsFieldId, 'DAM roots', damRootsField),
    ],
  });

  const commitSaver = createCommitSaver();

  let projectId: ProjectId | undefined = project?.id;
  let savedLabel = project?.label ?? '';
  let savedContentRoots = project?.contentRoots ?? '';
  let savedComponentRoots = project?.componentRoots ?? '';
  let savedPriorityPaths = project?.contentPriorityPaths ?? '';
  let savedDamRoots = project?.damRoots ?? '';
  /** Whether the remove warning is showing and the OK button is live. */
  let removeArmed = false;
  let busy = false;

  const removeAction: StatusBannerAction = {
    label: 'OK',
    onActivate(): void {
      if (busy || !removeArmed) return;
      removeArmed = false;
      // The prompt has served its purpose; persisting replaces it with
      // "Saving..." -> "Settings saved" via the save reporter.
      ctx.status.clear();
      void persistRemoval();
    },
  };

  function validateLabel(): { readonly ok: boolean; readonly label: string } {
    const result = validateProjectLabelInput(labelField.value);
    setInvalid(labelField, labelHelp, result.ok ? undefined : result.error);
    return result.ok ? { ok: true, label: result.label } : { ok: false, label: '' };
  }

  /**
   * Runs one save with the item's current values. Returns the outcome promise
   * for the reportSave wiring, or `undefined` when nothing was saved
   * (validation failed - already shown - or there is nothing dirty).
   */
  function runSave(): Promise<SaveOutcome> | undefined {
    if (busy) return undefined;

    const label = validateLabel();
    if (!label.ok) return undefined;

    const contentRoots = contentRootsField.value.trim();
    const componentRoots = componentRootsField.value.trim();
    const contentPriorityPaths = priorityPathsField.value.trim();
    const damRoots = damRootsField.value.trim();

    if (projectId === undefined) {
      return window.daisy.settings
        .addProject({
          label: label.label,
          ...(contentRoots.length > 0 ? { contentRoots } : {}),
          ...(componentRoots.length > 0 ? { componentRoots } : {}),
          ...(contentPriorityPaths.length > 0 ? { contentPriorityPaths } : {}),
          ...(damRoots.length > 0 ? { damRoots } : {}),
        })
        .then(
          (result) => {
            if (!result.ok) return { ok: false, error: result.error.message };
            projectId = result.project.id;
            savedLabel = result.project.label;
            savedContentRoots = result.project.contentRoots ?? '';
            savedComponentRoots = result.project.componentRoots ?? '';
            savedPriorityPaths = result.project.contentPriorityPaths ?? '';
            savedDamRoots = result.project.damRoots ?? '';
            return { ok: true };
          },
          (error: unknown) => ({
            ok: false,
            error: error instanceof Error ? error.message : 'Could not add project',
          }),
        );
    }

    // A removal confirmation is showing; nothing this run would save still
    // matters (the row is going away).
    if (removeArmed) return undefined;

    if (
      label.label === savedLabel &&
      contentRoots === savedContentRoots &&
      componentRoots === savedComponentRoots &&
      contentPriorityPaths === savedPriorityPaths &&
      damRoots === savedDamRoots
    ) {
      return undefined;
    }

    // A full replace: an empty field clears that root (main drops an empty
    // value), so an omitted key here is exactly "no roots written".
    const outcome: Promise<SaveOutcome> = window.daisy.settings
      .updateProject({
        projectId,
        label: label.label,
        ...(contentRoots.length > 0 ? { contentRoots } : {}),
        ...(componentRoots.length > 0 ? { componentRoots } : {}),
        ...(contentPriorityPaths.length > 0 ? { contentPriorityPaths } : {}),
        ...(damRoots.length > 0 ? { damRoots } : {}),
      })
      .then(
        (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not save project',
        }),
      );
    void outcome.then((result) => {
      if (result.ok) {
        savedLabel = label.label;
        savedContentRoots = contentRoots;
        savedComponentRoots = componentRoots;
        savedPriorityPaths = contentPriorityPaths;
        savedDamRoots = damRoots;
      }
    });
    return outcome;
  }

  /** Voids the removal warning on any *edit* (a spurious `change` does not). */
  function reconcilePendingActions(): void {
    if (removeArmed) {
      removeArmed = false;
      ctx.status.clear();
    }
  }

  /** Immediate inline feedback for the label, before any save. */
  function validateFieldsNow(): void {
    validateLabel();
  }

  /** Arms the serialized commit (see `createCommitSaver`). */
  function armCommit(): void {
    commitSaver.arm(() => {
      const outcome = runSave();
      if (outcome === undefined) return;
      ctx.reportSave(outcome);
      void outcome.then((result) => {
        if (result.ok) ctx.onSettingsChanged();
      });
    });
  }

  // `input` gives immediate inline feedback but never saves: a typed value is
  // committed only when the field is left (`change`: blur or Enter). This is
  // what stops a typing pause from creating a project out of a half-typed label.
  function onFieldInput(): void {
    reconcilePendingActions();
    validateFieldsNow();
  }

  function onFieldCommit(): void {
    reconcilePendingActions();
    validateFieldsNow();
    armCommit();
  }

  for (const field of [
    labelField,
    contentRootsField,
    componentRootsField,
    priorityPathsField,
    damRootsField,
  ]) {
    field.addEventListener('input', onFieldInput);
    field.addEventListener('change', onFieldCommit);
  }

  function persistRemoval(): void {
    if (busy) return;
    const id = projectId;
    if (id === undefined) {
      ctx.removeRow(key);
      return;
    }
    busy = true;
    commitSaver.cancel();
    const outcome: Promise<SaveOutcome> = window.daisy.settings
      .removeProject({ projectId: id })
      .then(
        (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not remove project',
        }),
      );
    // The reporter's settle is attached before our continuations, so a drain
    // that empties the batch is announced before the reload re-renders.
    ctx.reportSave(outcome);
    void outcome.then((result) => {
      if (result.ok) {
        ctx.onSettingsChanged();
        ctx.removeRow(key);
      }
      busy = false;
    });
  }

  function requestRemoval(): void {
    if (busy) return;
    if (projectId === undefined) {
      // A draft has nothing persisted to lose; removing it needs no confirmation.
      ctx.removeRow(key);
      return;
    }
    removeArmed = true;
    ctx.status.showPrompt(
      `This can't be undone. Press ${BANNER_ACTION_MARKER} to remove the project`,
      removeAction,
    );
  }

  return {
    key,
    element: fields,
    projectId: () => projectId,
    requestRemoval,
    isInProgress(): boolean {
      // A draft is unsaved work by definition - it must not be clobbered by a
      // snapshot re-read triggered from anywhere else in the panel.
      if (projectId === undefined) return true;
      return commitSaver.hasPending() || removeArmed;
    },
    flushNow(): Promise<void> {
      // Closing the panel is a commit point too: a field can hold input that
      // never blurred (the panel was dismissed with Escape). Force the same
      // commit a blur would, so nothing typed is silently dropped.
      reconcilePendingActions();
      armCommit();
      return commitSaver.flushNow();
    },
    dispose(): void {
      commitSaver.dispose();
    },
  };
}

export interface ProjectsSectionOptions {
  /** The panel's single status slot. */
  status: StatusBannerSink;
  /** Registers commit/confirming saves with the panel's save reporter. */
  reportSave(outcome: Promise<SaveOutcome>): void;
  /** Fired after any successful mutation so the panel re-reads the snapshot. */
  onSettingsChanged(): void;
}

export interface ProjectsSection {
  readonly element: HTMLElement;
  update(projects: readonly ProjectSnapshot[]): void;
  flushNow(): Promise<void>;
  hasPendingEdits(): boolean;
  dispose(): void;
}

/**
 * The projects section: a multifield of configured projects plus an "Add item"
 * action. The per-item rules live in `buildProjectItem`; the multifield chrome
 * (one row per line, labelled fields, up/down/remove actions, "Add item") lives
 * in the reusable `lib/multifield.ts`, exactly as the Hosts and Proxies tabs
 * use it.
 *
 * Reordering is persisted: moving a row up/down sends the complete new order of
 * the *persisted* projects to `settings:reorder-projects` (a draft has no id
 * yet, and the first valid commit creates it at the end of the list).
 */
export function createProjectsSection(options: ProjectsSectionOptions): ProjectsSection {
  let items = new Map<string, ProjectItemHandle>();
  let lastPersistedOrder: readonly ProjectId[] = [];
  let draftSeq = 0;
  let fieldSeq = 0;

  const itemContext: ProjectItemContext = {
    status: options.status,
    reportSave: (outcome) => options.reportSave(outcome),
    onSettingsChanged: () => options.onSettingsChanged(),
    removeRow,
  };

  const multifield = createMultifield({
    addLabel: 'Add item',
    onAdd: addDraft,
    onMove: () => persistOrder(),
    onRemove: (key) => items.get(key)?.requestRemoval(),
  });

  function sameOrder(order: readonly ProjectId[]): boolean {
    return (
      order.length === lastPersistedOrder.length &&
      order.every((id, index) => id === lastPersistedOrder[index])
    );
  }

  /** The persisted projects' current visual order (drafts excluded). */
  function currentSavedOrder(): ProjectId[] {
    return multifield
      .keys()
      .map((key) => items.get(key)?.projectId())
      .filter((id): id is ProjectId => id !== undefined);
  }

  function persistOrder(): void {
    const order = currentSavedOrder();
    // Reordering draft rows cannot change the persisted order (a draft has no
    // id); only a genuine change to the persisted entries is worth an IPC write.
    if (order.length < 2 || sameOrder(order)) return;

    const outcome: Promise<SaveOutcome> = window.daisy.settings
      .reorderProjects({ projectIds: order })
      .then(
        (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not reorder projects',
        }),
      );
    options.reportSave(outcome);
    void outcome.then((result) => {
      if (!result.ok) return;
      lastPersistedOrder = order;
      // Deliberately no `onSettingsChanged()`: a reload would rebuild every row
      // from the snapshot and drop the focus/accent on the field the user just
      // moved. The list already shows the new order, and this call persisted it;
      // the Hosts Project picker order follows on the next natural reload.
    });
  }

  function removeRow(key: string): void {
    const item = items.get(key);
    if (!item) return;
    items.delete(key);
    multifield.remove(key);
    item.dispose();
  }

  function addDraft(): void {
    const key = `draft:${String(++draftSeq)}`;
    const handle = buildProjectItem(undefined, key, `project-${String(++fieldSeq)}`, itemContext);
    items.set(key, handle);
    multifield.append({ key, element: handle.element });
    // Best effort: focus the new draft's label input so the user can type
    // immediately. The real Spectrum field has a shadow input; jsdom does not.
    handle.element.querySelector('input')?.focus();
  }

  function replaceItems(projects: readonly ProjectSnapshot[]): void {
    for (const item of items.values()) item.dispose();
    items = new Map();
    multifield.clear();
    for (const project of projects) {
      const key = `project:${project.id}`;
      const handle = buildProjectItem(project, key, `project-${String(++fieldSeq)}`, itemContext);
      items.set(key, handle);
      multifield.append({ key, element: handle.element });
    }
  }

  function hasPendingEdits(): boolean {
    for (const item of items.values()) {
      if (item.isInProgress()) return true;
    }
    return false;
  }

  const element = el('section', {
    attrs: { class: 'settings-section projects-section', 'aria-label': 'Projects' },
    children: [multifield.element],
  });

  return {
    element,
    update(projects: readonly ProjectSnapshot[]): void {
      lastPersistedOrder = projects.map((project) => project.id);
      if (hasPendingEdits()) return;
      // A rebuild detaches the focused field and drops the caret. The reload
      // that follows this row's own commit could therefore interrupt the user
      // mid-typing in a *different* field of the row, making the "Settings
      // saved" row look like it stole focus. The live rows already show the
      // user's committed edit, so nothing is lost by waiting for focus to
      // leave the section before rebuilding.
      if (containsFocus(element)) return;
      replaceItems(projects);
    },
    async flushNow(): Promise<void> {
      for (const item of items.values()) {
        await item.flushNow();
      }
    },
    hasPendingEdits,
    dispose(): void {
      for (const item of items.values()) item.dispose();
      items = new Map();
      multifield.dispose();
    },
  };
}
