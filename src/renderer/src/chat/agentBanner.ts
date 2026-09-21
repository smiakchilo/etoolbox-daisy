import {
  BANNER_TRANSITION_DURATION_MS,
  buildBannerCopy,
  collapseBannerRow,
  configureBannerTransition,
  createBannerActionButton,
  createBannerRow,
  isBannerClosing,
  restoreBannerRow,
  revealBannerRow,
} from '../lib/alertBanner';

/**
 * The chat pane's standing "no usable agent" row: an `sp-alert-banner` built
 * from the exact same factory methods, shared `banner-row` classes and
 * `banner.css` animation as the Settings panel's status slot
 * (`settings/statusBanner.ts`) - only the copy and the trigger differ.
 *
 * It is shown while no usable agent is selected (see `isAgentActive` in
 * `src/shared/contracts/agents.ts`): the selected provider either needs a
 * sign-in it does not have, or no provider is selected at all. The message
 * embeds a Settings control *inside* the sentence, so it uses
 * `buildBannerCopy` rather than `buildBannerPrompt`'s trailing action group.
 *
 * Unlike the Settings status slot this row has one fixed message: no priority
 * model, no auto-clear, and no user dismissal (it describes a standing
 * condition, so its close control is disabled). The row is still revealed and
 * collapsed by animating its own block-size, exactly like the other two
 * banners, so the transcript above it gives up the space gradually.
 */
export interface AgentBannerOptions {
  /** Opens the Settings panel on the Agents tab. */
  onOpenSettings(): void;
}

export interface AgentBanner {
  readonly element: HTMLElement;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createAgentBanner(options: AgentBannerOptions): AgentBanner {
  const row = createBannerRow('chat-banner');
  configureBannerTransition(row, BANNER_TRANSITION_DURATION_MS);
  // A standing condition, not an error to wave away: no close control, and
  // the component's own close event is neutralised rather than acted on.
  row.removeAttribute('dismissible');
  row.addEventListener('close', (event) => {
    event.preventDefault();
  });

  const settingsButton = createBannerActionButton('Settings');
  const handleSettingsClick = (): void => options.onOpenSettings();
  settingsButton.addEventListener('click', handleSettingsClick);

  row.append(buildBannerCopy(['Activate an agent in ', settingsButton, ' to send messages']));

  let visible = false;
  let collapseTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelCollapse(): void {
    if (collapseTimer !== undefined) {
      clearTimeout(collapseTimer);
      collapseTimer = undefined;
    }
  }

  function finalizeHide(): void {
    cancelCollapse();
    restoreBannerRow(row);
    row.removeAttribute('open');
  }

  function hide(): void {
    if (!row.hasAttribute('open')) {
      finalizeHide();
      return;
    }
    // Reduced motion makes `collapseBannerRow` return false: there is no
    // animation to wait on, so tear the row down synchronously.
    if (!collapseBannerRow(row)) {
      finalizeHide();
      return;
    }
    collapseTimer = setTimeout(finalizeHide, BANNER_TRANSITION_DURATION_MS);
  }

  function show(): void {
    // A row caught mid-collapse is unwound first, so re-adding `open` replays
    // the reveal from scratch rather than resuming a half-finished collapse.
    if (collapseTimer !== undefined) finalizeHide();
    if (row.hasAttribute('open') && !isBannerClosing(row)) return;
    row.setAttribute('open', '');
    revealBannerRow(row);
  }

  return {
    get element() {
      return row;
    },
    setVisible(next: boolean): void {
      if (next === visible) return;
      visible = next;
      if (next) show();
      else hide();
    },
    dispose(): void {
      settingsButton.removeEventListener('click', handleSettingsClick);
      cancelCollapse();
      restoreBannerRow(row);
      row.remove();
    },
  };
}
