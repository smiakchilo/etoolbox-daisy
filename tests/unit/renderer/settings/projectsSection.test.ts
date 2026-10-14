import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BANNER_ACTION_MARKER } from '../../../../src/renderer/src/lib/alertBanner';
import { createProjectsSection } from '../../../../src/renderer/src/settings/projectsSection';
import type {
  SaveOutcome,
  StatusBannerAction,
  StatusBannerSink,
} from '../../../../src/renderer/src/settings/statusBanner';
import { newProjectId, projectSnapshotSchema, type ProjectSnapshot } from '../../../../src/shared';

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;

const addProject = vi.fn();
const updateProject = vi.fn();
const removeProject = vi.fn();
const reorderProjects = vi.fn();

function snapshot(
  id: string,
  label: string,
  roots: {
    contentRoots?: string;
    componentRoots?: string;
    contentPriorityPaths?: string;
    damRoots?: string;
  } = {},
): ProjectSnapshot {
  return projectSnapshotSchema.parse({ id: newProjectId(() => id), label, ...roots });
}

interface PromptCapture {
  copy: string;
  action: StatusBannerAction;
}

let status: StatusBannerSink;
let lastPrompt: PromptCapture | undefined;
let reportSave: (outcome: Promise<SaveOutcome>) => void;
let onSettingsChanged: () => void;
const showPrompt = vi.fn<(copy: string, action: StatusBannerAction) => void>();

function buildSection() {
  return createProjectsSection({ status, reportSave, onSettingsChanged });
}

function field(
  root: ParentNode,
  ariaLabel: 'Label' | 'Content roots' | 'Component roots' | 'Content priority paths' | 'DAM roots',
) {
  return root.querySelector<HTMLElement & { value: string }>(`[aria-label="${ariaLabel}"]`);
}

function type(node: HTMLElement & { value: string }, value: string): void {
  node.value = value;
  node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

/** Leaves the field (`change`: blur or Enter), which is when a value commits. */
function commit(node: HTMLElement): void {
  node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

function typeAndCommit(node: HTMLElement & { value: string }, value: string): void {
  type(node, value);
  commit(node);
}

async function settle(ms = 1000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  addProject.mockReset();
  updateProject.mockReset();
  removeProject.mockReset();
  reorderProjects.mockReset();

  addProject.mockResolvedValue({
    ok: true,
    project: snapshot('created', 'Created'),
  });
  updateProject.mockResolvedValue({ ok: true });
  removeProject.mockResolvedValue({ ok: true });
  reorderProjects.mockResolvedValue({ ok: true });

  lastPrompt = undefined;
  showPrompt.mockReset();
  showPrompt.mockImplementation((copy, action) => {
    lastPrompt = { copy, action };
  });
  status = {
    showStatus: vi.fn(),
    showError: vi.fn(),
    showPrompt,
    showNotice: vi.fn(),
    clear: vi.fn(),
  };
  reportSave = vi.fn<(outcome: Promise<SaveOutcome>) => void>();
  onSettingsChanged = vi.fn<() => void>();

  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
  Reflect.set(dom.window, 'daisy', {
    settings: {
      addProject,
      updateProject,
      removeProject,
      reorderProjects,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

describe('createProjectsSection', () => {
  it('renders one labelled item per project with its five field labels', () => {
    const section = buildSection();
    section.update([
      snapshot('a', 'HPE', {
        contentRoots: '/content/a',
        componentRoots: '/apps/a',
        contentPriorityPaths: '/content/a/blueprint',
        damRoots: '/content/dam/a',
      }),
      snapshot('b', 'Acme'),
    ]);

    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(2);
    expect(field(section.element, 'Label')?.value).toBe('HPE');
    expect(field(section.element, 'Content roots')?.value).toBe('/content/a');
    expect(field(section.element, 'Component roots')?.value).toBe('/apps/a');
    expect(field(section.element, 'Content priority paths')?.value).toBe('/content/a/blueprint');
    expect(field(section.element, 'DAM roots')?.value).toBe('/content/dam/a');
    expect(section.element.querySelectorAll('sp-field-label')).toHaveLength(10);
  });

  it('orders the fields Component roots, Content roots, Content priority paths, DAM roots', () => {
    const section = buildSection();
    section.update([snapshot('a', 'HPE')]);

    const labels = [...section.element.querySelectorAll('sp-field-label')].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual([
      'Label (required)',
      'Component roots',
      'Content roots',
      'Content priority paths',
      'DAM roots',
    ]);
  });

  it('adds an empty draft only when "Add item" is clicked', () => {
    const section = buildSection();
    section.update([]);
    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(0);

    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(1);
    expect(field(section.element, 'Label')?.value).toBe('');
    expect(section.hasPendingEdits()).toBe(true);
  });

  it('creates a draft through addProject on the first valid label', async () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const label = field(section.element, 'Label');
    if (!label) throw new Error('missing label field');
    typeAndCommit(label, 'HPE');
    await settle();

    expect(addProject).toHaveBeenCalledExactlyOnceWith({ label: 'HPE' });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(reportSave).toHaveBeenCalledTimes(1);
  });

  it('does not save while typing, and only commits when the field is left', async () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const label = field(section.element, 'Label');
    if (!label) throw new Error('missing label field');
    type(label, 'HP');
    await settle();
    expect(addProject).not.toHaveBeenCalled();

    commit(label);
    await settle();
    expect(addProject).toHaveBeenCalledExactlyOnceWith({ label: 'HP' });
  });

  it('shows an inline invalid state and does not save when the required label is blank', async () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const label = field(section.element, 'Label');
    if (!label) throw new Error('missing label field');
    typeAndCommit(label, '   ');
    await settle();

    expect(label.hasAttribute('invalid')).toBe(true);
    expect(addProject).not.toHaveBeenCalled();
    expect(reportSave).not.toHaveBeenCalled();
  });

  it('saves a roots change via updateProject', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'HPE', { contentRoots: '/content/a' })]);

    const roots = field(section.element, 'Content roots');
    if (!roots) throw new Error('missing content roots field');
    typeAndCommit(roots, '  /content/a; /content/b  ');
    await settle();

    expect(updateProject).toHaveBeenCalledExactlyOnceWith({
      projectId: newProjectId(() => 'a'),
      label: 'HPE',
      contentRoots: '/content/a; /content/b',
    });
  });

  it('saves a priority-paths change via updateProject, and clears it when emptied', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'HPE', { contentRoots: '/content/a' })]);

    const priority = field(section.element, 'Content priority paths');
    if (!priority) throw new Error('missing priority paths field');
    typeAndCommit(priority, '  /content/a/x, /content/a/y  ');
    await settle();

    expect(updateProject).toHaveBeenLastCalledWith({
      projectId: newProjectId(() => 'a'),
      label: 'HPE',
      contentRoots: '/content/a',
      contentPriorityPaths: '/content/a/x, /content/a/y',
    });

    typeAndCommit(priority, '');
    await settle();

    expect(updateProject).toHaveBeenLastCalledWith({
      projectId: newProjectId(() => 'a'),
      label: 'HPE',
      contentRoots: '/content/a',
    });
  });

  it('saves a DAM-roots change via updateProject, and clears it when emptied', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'HPE', { contentRoots: '/content/a' })]);

    const dam = field(section.element, 'DAM roots');
    if (!dam) throw new Error('missing DAM roots field');
    typeAndCommit(dam, '  /content/dam/a, /content/dam/b  ');
    await settle();

    expect(updateProject).toHaveBeenLastCalledWith({
      projectId: newProjectId(() => 'a'),
      label: 'HPE',
      contentRoots: '/content/a',
      damRoots: '/content/dam/a, /content/dam/b',
    });

    typeAndCommit(dam, '');
    await settle();

    expect(updateProject).toHaveBeenLastCalledWith({
      projectId: newProjectId(() => 'a'),
      label: 'HPE',
      contentRoots: '/content/a',
    });
  });

  it('clears a root by emptying its field (a full replace omits it)', async () => {
    const section = buildSection();
    section.update([
      snapshot('a', 'HPE', { contentRoots: '/content/a', componentRoots: '/apps/a' }),
    ]);

    const componentRoots = field(section.element, 'Component roots');
    if (!componentRoots) throw new Error('missing component roots field');
    typeAndCommit(componentRoots, '');
    await settle();

    expect(updateProject).toHaveBeenCalledExactlyOnceWith({
      projectId: newProjectId(() => 'a'),
      label: 'HPE',
      contentRoots: '/content/a',
    });
  });

  it('persists the project order after a move', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'A'), snapshot('b', 'B')]);

    const firstRow = section.element.querySelector('.multifield__item');
    firstRow
      ?.querySelector('.multifield__action--down')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();

    expect(reorderProjects).toHaveBeenCalledExactlyOnceWith({
      projectIds: [newProjectId(() => 'b'), newProjectId(() => 'a')],
    });
  });

  it('confirms a saved project removal and removes its row', async () => {
    const section = buildSection();
    section.update([snapshot('a', 'HPE')]);

    section.element
      .querySelector('.multifield__action--remove')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(lastPrompt?.copy).toBe(
      `This can't be undone. Press ${BANNER_ACTION_MARKER} to remove the project`,
    );
    expect(removeProject).not.toHaveBeenCalled();

    lastPrompt?.action.onActivate();
    await settle();

    expect(removeProject).toHaveBeenCalledExactlyOnceWith({ projectId: newProjectId(() => 'a') });
    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(0);
  });

  it('removes a draft immediately, with no confirmation', () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    section.element
      .querySelector('.multifield__action--remove')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(0);
    expect(showPrompt).not.toHaveBeenCalled();
    expect(removeProject).not.toHaveBeenCalled();
  });

  it('does not let a snapshot update clobber an unsaved draft', () => {
    const section = buildSection();
    section.update([]);
    section.element
      .querySelector('.multifield__add')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const label = field(section.element, 'Label');
    if (!label) throw new Error('missing label field');
    type(label, 'Draft');

    section.update([snapshot('a', 'HPE')]);

    expect(section.element.querySelectorAll('.multifield__item')).toHaveLength(1);
    expect(field(section.element, 'Label')?.value).toBe('Draft');
  });
});
