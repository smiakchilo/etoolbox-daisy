import type { AgentChatSkill, AppInfo } from '../../../shared';
import appIconUrl from '../../../../resources/icon.png';
import { el } from '../lib/dom';
import { CLOSE_ICON_TAG, registerCloseIcon } from './closeIcon';

/**
 * The browser pane's home (welcome) screen: the base layer of the page-view
 * slot, shown whenever the AEM view has no committed document to display and
 * no panel is covering the region.
 *
 * It exists so the left pane is never a blank native surface. The AEM view
 * paints *above* the renderer document (an Electron `WebContentsView` always
 * composites over it), so the pane collapses the native view whenever
 * `hasDocument` is false and lets this DOM layer show through - the same
 * suspension mechanism the whole-size panels use (see `browserPane.ts`).
 *
 * Everything static is built synchronously at construction, so it is part of
 * the shell's first paint; the app name/version and the tool list arrive later
 * through `setAppInfo`/`setSkills` and only enrich an already-visible screen.
 * The tool list is deliberately not hardcoded: it is the user-invocable half of
 * the application's own `resources/skills` catalogue
 * (`window.daisy.agentChat.listSkills()`), whose description is the skill's
 * user-facing `metadata.user-description` front matter (falling back to the
 * technical `description`). A skill a user adds to that folder shows up here
 * automatically.
 *
 * Beneath that list is a static **Shortcuts** section (`HOME_SHORTCUTS`), the
 * app's useful keystrokes as prose. It is hand-maintained against the key map in
 * `src/main/shortcuts.ts`; AGENTS.md requires it to be revised whenever a
 * shortcut is added, edited or removed.
 *
 * The screen is shown for two reasons: as the genuine empty state (no document
 * loaded - nothing to close) and as a *user-forced veil* over a loaded document
 * (the toolbar's Home button - here a close control returns to the page, since
 * the screen is not a history position and the address bar has nothing to
 * show). `setClosable` distinguishes the two.
 */
export interface HomeScreen {
  readonly element: HTMLElement;
  /** Fills the app name/version; the static fallback name is already shown. */
  setAppInfo(info: AppInfo): void;
  /** Shows the button that starts the pending update, naming its version; `undefined` hides it. */
  setUpdateAvailable(version: string | undefined): void;
  /** Replaces the tool list with the user-invocable catalogue (empty ⇒ an honest "none" state). */
  setSkills(skills: readonly AgentChatSkill[]): void;
  /** Enables/disables the "Choose a host" affordance; there is nothing to pick with zero hosts. */
  setHostsAvailable(available: boolean): void;
  /**
   * Shows/hides the close ("back to page") control. It is offered only when the
   * home screen was *forced over a loaded document* - there is a page to return
   * to. When it is the genuine empty state (no document loaded), there is
   * nothing to close, so the control stays hidden.
   */
  setClosable(closable: boolean): void;
}

export interface HomeScreenCallbacks {
  readonly onOpenHosts: () => void;
  /** Opens the app's History (stored conversations) panel. */
  readonly onOpenHistory: () => void;
  readonly onOpenSettings: () => void;
  /** Starts the pending update (the accent "Update X available" button). */
  readonly onApplyUpdate: () => void;
  /**
   * Fired by the close control: the user is done with the forced home screen and
   * wants the page back. The owning pane reveals the page the veil was covering
   * (the home screen is not a history position, so this is not a navigation).
   */
  readonly onClose: () => void;
}

/** The product name shown before (and, defensively, if not replaced by) `getAppInfo`. */
const FALLBACK_APP_NAME = 'EToolbox Daisy';

/**
 * One keystroke the home screen advertises, described exactly as
 * `resolveShortcut` (`src/main/shortcuts.ts`) matches it: the physical `code`,
 * the optional produced `key` (the empty-`code` numpad `+`/`-` fallback), and
 * the modifier flags. The display label is derived from these fields - see
 * {@link formatShortcut} - so the advertised text can never drift from the
 * binding it names.
 */
export interface HomeKeystroke {
  /** The physical key (`KeyboardEvent.code`), e.g. `KeyH`, `NumpadAdd`. */
  readonly code: string;
  /** The produced key, for the empty-`code` numpad fallback. */
  readonly key?: string;
  readonly control?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

/** One row of the home screen's "Shortcuts" section. */
export interface HomeShortcut {
  /** Alternative keystrokes that trigger the same behaviour (at least one). */
  readonly keystrokes: readonly HomeKeystroke[];
  /** What the keystroke does, in a short phrase. */
  readonly description: string;
}

/**
 * The keystrokes the home screen's "Shortcuts" section lists, beneath "Useful
 * commands". This is hand-maintained prose (the app has no menu bar to derive it
 * from), matched by hand to the key map in `src/main/shortcuts.ts`. AGENTS.md
 * requires it to be revised whenever a shortcut is added, edited or deleted; a
 * unit test cross-checks every entry against `resolveShortcut`, so an entry that
 * no longer names a live binding fails the suite.
 */
export const HOME_SHORTCUTS: readonly HomeShortcut[] = [
  { keystrokes: [{ code: 'ArrowLeft', alt: true }], description: 'Go back' },
  { keystrokes: [{ code: 'ArrowRight', alt: true }], description: 'Go forward' },
  { keystrokes: [{ code: 'Home', alt: true }], description: 'Show the home screen' },
  {
    keystrokes: [{ code: 'F5' }, { code: 'KeyR', control: true }],
    description: 'Refresh the page',
  },
  { keystrokes: [{ code: 'KeyL', control: true }], description: 'Focus the address bar' },
  { keystrokes: [{ code: 'KeyF', control: true }], description: 'Find on the page' },
  { keystrokes: [{ code: 'NumpadAdd', control: true }], description: 'Zoom in' },
  { keystrokes: [{ code: 'NumpadSubtract', control: true }], description: 'Zoom out' },
  { keystrokes: [{ code: 'Digit0', control: true }], description: 'Reset the zoom' },
  { keystrokes: [{ code: 'KeyH', control: true }], description: 'Open History' },
  { keystrokes: [{ code: 'KeyN', control: true }], description: 'Start a new session' },
  { keystrokes: [{ code: 'Comma', control: true }], description: 'Open Settings' },
];

/** Human labels for the physical keys the section names; an unknown code shows verbatim. */
const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Comma: ',',
  Digit0: '0',
  F5: 'F5',
  Home: 'Home',
  KeyF: 'F',
  KeyH: 'H',
  KeyL: 'L',
  KeyN: 'N',
  KeyR: 'R',
  NumpadAdd: 'Numpad +',
  NumpadSubtract: 'Numpad \u2212',
};

/** `Ctrl`/`Alt`/`Shift` prefixes then the key label, e.g. `Ctrl+Numpad +`. */
function formatKeystroke(keystroke: HomeKeystroke): string {
  const parts: string[] = [];
  if (keystroke.control) parts.push('Ctrl');
  if (keystroke.alt) parts.push('Alt');
  if (keystroke.shift) parts.push('Shift');
  parts.push(KEY_LABELS[keystroke.code] ?? keystroke.code);
  return parts.join('+');
}

/** All of a shortcut's alternative keystrokes, e.g. `F5 or Ctrl+R`. */
function formatShortcut(shortcut: HomeShortcut): string {
  return shortcut.keystrokes.map(formatKeystroke).join(' or ');
}

export function createHomeScreen(callbacks: HomeScreenCallbacks): HomeScreen {
  const name = el('h1', { attrs: { class: 'browser-home__name' }, text: FALLBACK_APP_NAME });
  const version = el('p', { attrs: { class: 'browser-home__version' } });
  version.hidden = true;
  const updateLink = el('sp-action-button', {
    attrs: {
      class: 'browser-home__update action-button--primary',
      size: 's',
      'data-testid': 'home-update-link',
    },
  });
  updateLink.hidden = true;
  updateLink.addEventListener('click', () => callbacks.onApplyUpdate());

  // The version and the update link share one line; the line is itself hidden
  // when both are, so an empty row never takes a slot in the hero's column.
  const meta = el('div', {
    attrs: { class: 'browser-home__meta' },
    children: [version, updateLink],
  });
  const syncMeta = (): void => {
    meta.hidden = version.hidden && updateLink.hidden;
  };
  syncMeta();

  // The close control: shown only when the home screen was forced over a
  // loaded document (`setClosable`). It is not a browser Back - it dismisses
  // the veil to reveal the page underneath - so it is worded as such. Hidden
  // by default, so the genuine empty state (nothing to return to) offers no
  // misleading affordance. It deliberately reuses the panels' close affordance
  // (the app's own hairline `daisy-close-icon`, see `closeIcon.ts` and
  // `panel.ts`) rather than a Spectrum cross, so the same "dismiss this
  // surface" gesture looks identical everywhere.
  registerCloseIcon();
  const closeButton = el('sp-action-button', {
    attrs: {
      class: 'browser-home__close',
      quiet: '',
      title: 'Back to page',
      'aria-label': 'Back to page',
      'data-testid': 'home-close',
    },
  });
  const closeIcon = document.createElement(CLOSE_ICON_TAG);
  closeIcon.setAttribute('slot', 'icon');
  closeButton.append(closeIcon);
  closeButton.hidden = true;
  closeButton.addEventListener('click', () => callbacks.onClose());

  const icon = el('img', {
    attrs: { class: 'browser-home__icon', src: appIconUrl, alt: '' },
  });

  const hero = el('div', {
    attrs: { class: 'browser-home__hero' },
    children: [icon, name, meta],
  });

  const hostsButton = el('sp-action-button', {
    attrs: {
      class: 'browser-home__action',
      title: 'Select a host',
      'aria-label': 'Select a host',
      'data-testid': 'home-hosts',
    },
    text: 'Select a host',
  });
  hostsButton.addEventListener('click', () => callbacks.onOpenHosts());

  const historyButton = el('sp-action-button', {
    attrs: {
      class: 'browser-home__action',
      title: 'History',
      'aria-label': 'History',
      'data-testid': 'home-history',
    },
    text: 'History',
  });
  historyButton.addEventListener('click', () => callbacks.onOpenHistory());

  const settingsButton = el('sp-action-button', {
    attrs: {
      class: 'browser-home__action',
      title: 'Settings',
      'aria-label': 'Settings',
      'data-testid': 'home-settings',
    },
    text: 'Settings',
  });
  settingsButton.addEventListener('click', () => callbacks.onOpenSettings());

  const actions = el('div', {
    attrs: { class: 'browser-home__actions' },
    children: [hostsButton, historyButton, settingsButton],
  });

  const toolsHeading = el('h2', {
    attrs: { class: 'browser-home__section-title' },
    text: 'Useful commands',
  });

  const toolsList = el('ul', { attrs: { class: 'browser-home__skill-list' } });

  const toolsStatus = el('p', {
    attrs: { class: 'browser-home__skills-status' },
    text: 'Loading commands\u2026',
  });

  const skills = el('div', {
    attrs: { class: 'browser-home__skills' },
    children: [toolsHeading, toolsStatus, toolsList],
  });

  // The static "Shortcuts" section, beneath "Useful commands". It is built at
  // construction (like the rest of the screen's fixed content) from
  // HOME_SHORTCUTS, which is hand-maintained against the app's key map - see
  // its own note.
  const shortcuts = el('div', {
    attrs: { class: 'browser-home__shortcuts', 'data-testid': 'home-shortcuts' },
    children: [
      el('h2', { attrs: { class: 'browser-home__section-title' }, text: 'Shortcuts' }),
      el('ul', {
        attrs: { class: 'browser-home__shortcut-list' },
        children: HOME_SHORTCUTS.map((shortcut) =>
          el('li', {
            attrs: { class: 'browser-home__shortcut', 'data-testid': 'home-shortcut' },
            children: [
              el('span', {
                attrs: { class: 'browser-home__shortcut-keys' },
                text: formatShortcut(shortcut),
              }),
              el('span', {
                attrs: { class: 'browser-home__shortcut-description' },
                text: shortcut.description,
              }),
            ],
          }),
        ),
      }),
    ],
  });

  // The fixed header: the app icon/name and the three action buttons. It does
  // *not* scroll, so the scrollable region (and its scrollbar) begins beneath
  // the buttons and can never sit under the close control, which is pinned to
  // the top-right of `.browser-home`.
  const header = el('div', {
    attrs: { class: 'browser-home__header' },
    children: [hero, actions],
  });

  // The scrollable body: the "Useful commands" and "Shortcuts" sections. The
  // scroll lives here, *not* on `.browser-home`, so the absolutely positioned
  // close control (a sibling, outside this element) cannot shift by the
  // scrollbar width - see home.css.
  const content = el('div', {
    attrs: { class: 'browser-home__scroll' },
    children: [skills, shortcuts],
  });

  const element = el('section', {
    attrs: { class: 'browser-home', 'aria-label': 'Welcome' },
    children: [closeButton, header, content],
  });

  return {
    element,
    setAppInfo(info: AppInfo): void {
      name.textContent = info.name === '' ? FALLBACK_APP_NAME : info.name;
      version.textContent = info.version === '' ? '' : `Version ${info.version}`;
      version.hidden = info.version === '';
      syncMeta();
    },
    setUpdateAvailable(pending: string | undefined): void {
      updateLink.hidden = pending === undefined;
      updateLink.textContent = pending === undefined ? '' : `Update ${pending} available`;
      syncMeta();
    },
    setSkills(catalogue: readonly AgentChatSkill[]): void {
      toolsStatus.hidden = true;
      toolsList.replaceChildren(
        ...catalogue.map((skill) =>
          el('li', {
            attrs: { class: 'browser-home__skill' },
            children: [
              el('span', { attrs: { class: 'browser-home__skill-name' }, text: `/${skill.name}` }),
              el('span', {
                attrs: { class: 'browser-home__skill-description' },
                text: skill.description,
              }),
            ],
          }),
        ),
      );
      if (catalogue.length === 0) {
        toolsList.hidden = true;
        toolsStatus.hidden = false;
        toolsStatus.textContent = 'No user-invocable commands are installed.';
      }
    },
    setHostsAvailable(available: boolean): void {
      if (available) {
        hostsButton.removeAttribute('disabled');
        hostsButton.setAttribute('title', 'Select a host');
      } else {
        hostsButton.setAttribute('disabled', '');
        hostsButton.setAttribute('title', 'No hosts are configured yet \u2014 add one in Settings');
      }
    },
    setClosable(closable: boolean): void {
      closeButton.hidden = !closable;
    },
  };
}
