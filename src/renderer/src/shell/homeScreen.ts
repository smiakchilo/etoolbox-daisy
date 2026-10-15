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
  /**
   * Fired by the close control: the user is done with the forced home screen and
   * wants the page back. The owning pane reveals the page the veil was covering
   * (the home screen is not a history position, so this is not a navigation).
   */
  readonly onClose: () => void;
}

/** The product name shown before (and, defensively, if not replaced by) `getAppInfo`. */
const FALLBACK_APP_NAME = 'EToolbox Daisy';

export function createHomeScreen(callbacks: HomeScreenCallbacks): HomeScreen {
  const name = el('h1', { attrs: { class: 'browser-home__name' }, text: FALLBACK_APP_NAME });
  const version = el('p', { attrs: { class: 'browser-home__version' } });
  version.hidden = true;

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
    children: [icon, name, version],
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

  // The scrollable body. The scroll lives here, *not* on `.browser-home`, so
  // the absolutely positioned close control (a sibling, outside this element)
  // cannot shift by the scrollbar width when the tools list overflows - see
  // home.css.
  const content = el('div', {
    attrs: { class: 'browser-home__scroll' },
    children: [hero, actions, skills],
  });

  const element = el('section', {
    attrs: { class: 'browser-home', 'aria-label': 'Welcome' },
    children: [closeButton, content],
  });

  return {
    element,
    setAppInfo(info: AppInfo): void {
      name.textContent = info.name === '' ? FALLBACK_APP_NAME : info.name;
      version.textContent = info.version === '' ? '' : `Version ${info.version}`;
      version.hidden = info.version === '';
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
