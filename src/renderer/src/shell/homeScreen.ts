import type { AgentChatSkill, AppInfo } from '../../../shared';
import appIconUrl from '../../../../resources/icon.png';
import { el } from '../lib/dom';

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
 */
export interface HomeScreen {
  readonly element: HTMLElement;
  /** Fills the app name/version; the static fallback name is already shown. */
  setAppInfo(info: AppInfo): void;
  /** Replaces the tool list with the user-invocable catalogue (empty ⇒ an honest "none" state). */
  setSkills(skills: readonly AgentChatSkill[]): void;
  /** Enables/disables the "Choose a host" affordance; there is nothing to pick with zero hosts. */
  setHostsAvailable(available: boolean): void;
}

export interface HomeScreenCallbacks {
  readonly onOpenHosts: () => void;
  readonly onOpenSettings: () => void;
}

/** The product name shown before (and, defensively, if not replaced by) `getAppInfo`. */
const FALLBACK_APP_NAME = 'EToolbox Daisy';

export function createHomeScreen(callbacks: HomeScreenCallbacks): HomeScreen {
  const name = el('h1', { attrs: { class: 'browser-home__name' }, text: FALLBACK_APP_NAME });
  const version = el('p', { attrs: { class: 'browser-home__version' } });
  version.hidden = true;

  const icon = el('img', {
    attrs: { class: 'browser-home__icon', src: appIconUrl, alt: '' },
  });

  const hero = el('div', {
    attrs: { class: 'browser-home__hero' },
    children: [icon, name, version],
  });

  const hostsButton = el('sp-action-button', {
    attrs: { class: 'browser-home__action', title: 'Select a host', 'aria-label': 'Select a host' },
    text: 'Select a host',
  });
  hostsButton.addEventListener('click', () => callbacks.onOpenHosts());

  const settingsButton = el('sp-action-button', {
    attrs: {
      class: 'browser-home__action',
      title: 'Open settings',
      'aria-label': 'Open settings',
    },
    text: 'Open settings',
  });
  settingsButton.addEventListener('click', () => callbacks.onOpenSettings());

  const actions = el('div', {
    attrs: { class: 'browser-home__actions' },
    children: [hostsButton, settingsButton],
  });

  const toolsHeading = el('h2', {
    attrs: { class: 'browser-home__section-title' },
    text: 'Useful tools',
  });

  const toolsList = el('ul', { attrs: { class: 'browser-home__skill-list' } });

  const toolsStatus = el('p', {
    attrs: { class: 'browser-home__skills-status' },
    text: 'Loading tools\u2026',
  });

  const skills = el('div', {
    attrs: { class: 'browser-home__skills' },
    children: [toolsHeading, toolsStatus, toolsList],
  });

  const element = el('section', {
    attrs: { class: 'browser-home', 'aria-label': 'Welcome' },
    children: [hero, actions, skills],
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
        toolsStatus.textContent = 'No user-invocable tools are installed.';
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
  };
}
