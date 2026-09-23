import { el } from '../lib/dom';
import type { AgentChatSkill } from '../../../shared';

/**
 * The composer's `/` autocomplete popup, drawn with Spectrum's own overlay and
 * popover so it matches the transcript's link-action popover
 * (`linkActionPopover.ts`): Spectrum's rounded, shadowed chrome, the overlay's
 * own placement/flip rather than hand-rolled positioning, and a portal above
 * the pane so the composer can never clip it.
 *
 * One `sp-overlay` + `sp-popover` is created for the composer's lifetime,
 * anchored to the composer frame via `triggerElement`, and its rows are rebuilt
 * on every keystroke. Returns `undefined` when the overlay/popover tags are not
 * registered - notably under jsdom, where the unit suite imports the composer
 * but never loads Spectrum. There the autocomplete's pure state
 * (`composerSkillsViewModel.ts`) is still maintained, and the real popup is
 * covered by the E2E instead.
 */

export interface SkillPopover {
  /** Draws `suggestions`, highlights `selectedIndex`, and shows the popup above `anchor`. */
  show(anchor: HTMLElement, suggestions: readonly AgentChatSkill[], selectedIndex: number): void;
  /** Hides the popup. Safe to call when it is already hidden. */
  hide(): void;
  dispose(): void;
}

export interface SkillPopoverOptions {
  /** Invoked with the index of the row the user clicked. */
  readonly onAccept: (index: number) => void;
  /** Where to attach the overlay; must sit inside the active `sp-theme` so the popover is themed. */
  readonly getContainer: () => HTMLElement;
}

export function createSkillPopover(options: SkillPopoverOptions): SkillPopover | undefined {
  if (
    typeof customElements === 'undefined' ||
    customElements.get('sp-overlay') === undefined ||
    customElements.get('sp-popover') === undefined
  ) {
    return undefined;
  }

  const list = el('div', {
    attrs: { class: 'chat-composer__skills', role: 'listbox', 'aria-label': 'Skills' },
  });
  const popover = el('sp-popover', { attrs: { class: 'chat-skill-popover' } });
  popover.append(list);
  const overlay = el('sp-overlay', {
    attrs: {
      class: 'chat-skill-overlay',
      type: 'manual',
      placement: 'top',
      offset: '8',
      // The field keeps focus and owns all key handling; the popup must never
      // take focus or a click would move the caret.
      'receives-focus': 'false',
    },
  });
  overlay.append(popover);

  let anchored = false;
  let disposed = false;

  function render(suggestions: readonly AgentChatSkill[], selectedIndex: number): void {
    list.replaceChildren(
      ...suggestions.map((skill, index) => {
        const row = el('div', {
          attrs: {
            class: 'chat-composer__skill',
            role: 'option',
            'aria-selected': index === selectedIndex ? 'true' : 'false',
            title: skill.description,
          },
          children: [
            el('span', { attrs: { class: 'chat-composer__skill-name' }, text: skill.name }),
            el('span', {
              attrs: { class: 'chat-composer__skill-description' },
              text: skill.description,
            }),
          ],
        });
        // `mousedown`, not `click`: it fires before the field can lose focus, so
        // the caret stays where the user left it when the name is inserted.
        row.addEventListener('mousedown', (event) => {
          event.preventDefault();
          options.onAccept(index);
        });
        return row;
      }),
    );
  }

  return {
    show(anchor, suggestions, selectedIndex) {
      if (disposed) return;
      if (!anchored) {
        options.getContainer().append(overlay);
        overlay.triggerElement = anchor;
        anchored = true;
      }
      render(suggestions, selectedIndex);
      overlay.open = true;
    },
    hide() {
      if (disposed) return;
      overlay.open = false;
    },
    dispose() {
      disposed = true;
      overlay.open = false;
      overlay.remove();
    },
  };
}
