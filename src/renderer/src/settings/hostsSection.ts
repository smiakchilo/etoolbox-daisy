import { el } from '../lib/dom';
import { resolveServerColorCss, resolveServerSwatchFromHex } from '../lib/serverColor';
import {
  SERVER_SWATCHES,
  type ServerColor,
  type ServerSnapshot,
  type ServerSwatch,
} from '../../../shared';
import { createPasswordEntry } from './passwordEntry';
import { createAutoSave } from './autoSave';
import type { SaveOutcome, StatusBannerAction, StatusBannerSink } from './statusBanner';
import {
  describeProxySnapshot,
  validateEditServerForm,
  validateNewServerForm,
  validateOriginInput,
} from './viewModel';

type TextField = HTMLElement & { value: string };

const SWATCH_SET = new Set<string>(SERVER_SWATCHES);

/** Narrowing guard: is this (possibly user-typed) string one of the named swatches? */
function isSwatch(value: string): value is ServerSwatch {
  return SWATCH_SET.has(value);
}

/** The label shown in the picker's menu: the swatch key with a capital first letter. */
function swatchLabel(swatch: string): string {
  return swatch.charAt(0).toUpperCase() + swatch.slice(1);
}

/**
 * The colour picker shared by the add-host form and each row's inline edit
 * form: a plain, always-typable `sp-textfield` holding a `#rrggbb` hex string
 * (typed freely, or a named swatch's concrete value written by a pick) plus
 * an `sp-action-menu` "picker button" beside it listing the named swatches
 * with their colour dots. Selecting an item writes that swatch's hex into the
 * field - the exact same textfield-plus-picker-button pattern as the browser
 * toolbar's address bar/hosts picker (`browserToolbar.ts`), chosen for the
 * same reason: it keeps the field itself as the single source of truth and
 * typable at all times, with the menu as a pure convenience for the common
 * case. The field accepts a bare swatch name like `blue` as shorthand, and on
 * read a value matching a named swatch's hex round-trips back to the swatch.
 * Unlike that address bar, this button never needs to hide -
 * `SERVER_SWATCHES` is a fixed, always-non-empty list - so there is no
 * `[hidden]` handling here.
 */
function createColorPicker(
  initial?: ServerColor,
  onInput?: () => void,
): {
  readonly element: HTMLElement;
  read():
    | { readonly kind: 'swatch'; readonly swatch: string }
    | { readonly kind: 'custom'; readonly hex: string };
  setValue(color: ServerColor): void;
} {
  const colorField = el('sp-textfield', {
    attrs: {
      class: 'color-picker__field',
      placeholder: '#2680eb or a swatch name',
      'aria-label': 'Colour',
    },
  }) as TextField;

  const colorMenuButton = el('sp-action-menu', {
    attrs: { class: 'color-picker-button', quiet: '', label: 'Choose colour' },
  }) as HTMLElement & { value: string };
  const colorMenuIcon = document.createElement('sp-icon-chevron-down');
  colorMenuIcon.setAttribute('slot', 'icon');
  colorMenuButton.append(
    colorMenuIcon,
    ...SERVER_SWATCHES.map((swatch) => {
      const dot = el('span', {
        attrs: { class: 'server-swatch color-picker__swatch', role: 'presentation' },
      });
      dot.style.backgroundColor = resolveServerColorCss({ kind: 'swatch', swatch });
      dot.setAttribute('slot', 'icon');
      return el('sp-menu-item', {
        attrs: { value: swatch },
        text: swatchLabel(swatch),
        children: [dot],
      });
    }),
  );

  // Same reasoning as `serverMenuButton.addEventListener("change", ...)` in
  // browserToolbar.ts: selecting an item just writes a value into the field,
  // then the field is the only thing read back. Here the value written is the
  // swatch's concrete hex - never its name - so the field always holds one
  // format, and the menu keeps showing the human label (`swatchLabel`).
  colorMenuButton.addEventListener('change', () => {
    const swatch = colorMenuButton.value.trim().toLowerCase();
    if (!isSwatch(swatch)) return;
    colorField.value = resolveServerColorCss({ kind: 'swatch', swatch });
    onInput?.();
  });

  if (onInput) {
    colorField.addEventListener('input', onInput);
    colorField.addEventListener('change', onInput);
  }

  function setValue(color: ServerColor): void {
    colorField.value =
      color.kind === 'custom'
        ? color.hex
        : resolveServerColorCss({ kind: 'swatch', swatch: color.swatch });
  }

  setValue(initial ?? { kind: 'swatch', swatch: SERVER_SWATCHES[0] });

  const element = el('div', {
    attrs: { class: 'color-picker' },
    children: [colorField, colorMenuButton],
  });

  return {
    element,
    read() {
      const value = colorField.value.trim();
      const normalized = value.toLowerCase();
      if (SWATCH_SET.has(normalized)) {
        return { kind: 'swatch', swatch: normalized };
      }
      // A picked swatch put its hex in the field; a known swatch hex must
      // round-trip back to the swatch, or an untouched pick would degrade to a
      // stored `custom` value (and flag the colour dirty on the next save).
      const swatch = resolveServerSwatchFromHex(normalized);
      if (swatch !== undefined) {
        return { kind: 'swatch', swatch };
      }
      return { kind: 'custom', hex: value };
    },
    setValue,
  };
}

/** Normalizes a colour to a comparable key, so "is the colour dirty?" ignores case and surrounding whitespace. */
function colorKey(
  color:
    | ServerColor
    | { readonly kind: 'swatch'; readonly swatch: string }
    | { readonly kind: 'custom'; readonly hex: string },
): string {
  return color.kind === 'custom'
    ? `custom:${color.hex.trim().toLowerCase()}`
    : `swatch:${color.swatch.trim().toLowerCase()}`;
}

/** Everything a server row needs from the section (and, one level up, the panel). */
interface ServerRowContext {
  status: StatusBannerSink;
  reportSave(outcome: Promise<SaveOutcome>): void;
  onSettingsChanged(): void;
}

interface ServerRowHandle {
  readonly element: HTMLElement;
  flushNow(): Promise<void>;
  /** True while this row has unsaved input or an unconfirmed action pending. */
  isInProgress(): boolean;
  dispose(): void;
}

/**
 * One server row. Its label, colour and address are always editable in place.
 * Label and colour auto-save (~1s after the last edit) exactly like the proxy
 * section's fields, with no Save button.
 *
 * Changing a server's address needs a *separate* warning and confirmation
 * (requirements-decisions.md section 7), so it never applies automatically:
 * the first debounce after the edit raises a one-button confirmation in the
 * panel's banner ("Confirm changing the address" -> OK), and that single OK
 * click persists it. Removing a server gets the same treatment: the banner
 * warns what deletion takes with it, and an OK button performs it. A staged
 * confirmation is reconciled against the field's *value*: typing a different
 * address (or reverting to the original one) re-raises or cancels the warning
 * on the next debounce, while the blur "change" that clicking OK itself causes
 * re-commits the same value and must not wipe the confirmation. There is no
 * modal dialog framework in this renderer, so these confirmations live in the
 * banner rather than a dialog.
 */
function buildServerRow(server: ServerSnapshot, ctx: ServerRowContext): ServerRowHandle {
  const swatch = el('span', { attrs: { class: 'server-swatch', role: 'presentation' } });
  swatch.style.backgroundColor = resolveServerColorCss(server.color);

  const heading = el('h3', { attrs: { class: 'server-row__heading' }, children: [swatch] });
  heading.append(document.createTextNode(` ${server.label}`));

  const proxyLine = el('p', { text: `AEM proxy: ${describeProxySnapshot(server.proxy)}` });

  const labelField = el('sp-textfield', { attrs: { 'aria-label': 'Host label' } }) as TextField;
  labelField.value = server.label;
  const originField = el('sp-textfield', {
    attrs: { 'aria-label': 'Host address' },
  }) as TextField;
  originField.value = server.origin;
  const colorPicker = createColorPicker(server.color, armRowSave);

  const removeButton = el('sp-button', { attrs: { variant: 'negative' }, text: 'Remove' });
  const autoSave = createAutoSave();

  /** The exact origin the user has been warned about; the OK click persists it. */
  let pendingOrigin: string | undefined;
  /** Whether the remove warning is showing and the OK button is live. */
  let removeArmed = false;
  let busy = false;

  function setBusy(value: boolean): void {
    busy = value;
    if (value) removeButton.setAttribute('disabled', '');
    else removeButton.removeAttribute('disabled');
  }

  function hasOriginChange(): string | undefined {
    const originResult = validateOriginInput(originField.value);
    if (!originResult.ok || originResult.origin === server.origin) return undefined;
    return originResult.origin;
  }

  // The confirming action: a single OK click persists the staged origin.
  const applyOriginAction: StatusBannerAction = {
    label: 'OK',
    onActivate(): void {
      if (busy || pendingOrigin === undefined) return;
      const origin = pendingOrigin;
      pendingOrigin = undefined;
      // The prompt has served its purpose; persisting replaces it with
      // "Saving..." -> "Settings saved" via the save reporter.
      ctx.status.clear();
      void persistOrigin(origin);
    },
  };

  function showOriginPrompt(origin: string): void {
    pendingOrigin = origin;
    ctx.status.showPrompt('Confirm changing the address', applyOriginAction);
  }

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

  /**
   * Runs one save with the row's current values. The label/colour save is a
   * debounced auto-save; an origin edit only ever raises (or refreshes) the
   * confirmation prompt - it is never applied by the debounce. Returns the
   * outcome promise for the reportSave wiring, or `undefined` when nothing
   * was saved (validation failed - already shown - or there is nothing dirty).
   */
  function runRowSave(): Promise<SaveOutcome> | undefined {
    if (busy) return undefined;
    // A removal confirmation is showing; nothing this run would save or warn
    // about still matters (the row is going away), and re-raising the origin
    // warning here would clobber the removal prompt.
    if (removeArmed) return undefined;

    const presentation = validateEditServerForm({
      label: labelField.value,
      color: colorPicker.read(),
    });
    if (!presentation.ok) {
      ctx.status.showError(Object.values(presentation.errors).filter(Boolean).join(' | '));
      return undefined;
    }

    const changedOrigin = hasOriginChange();
    if (changedOrigin !== undefined) {
      showOriginPrompt(changedOrigin);
    } else if (pendingOrigin !== undefined) {
      // The user put the address back; the staged confirmation is void.
      pendingOrigin = undefined;
      ctx.status.clear();
    }

    const presentationChanged =
      presentation.value.label !== server.label ||
      colorKey(presentation.value.color) !== colorKey(server.color);
    if (!presentationChanged) return undefined;

    const changes: { label: string; color: ServerColor } = {
      label: presentation.value.label,
      color: presentation.value.color,
    };
    return window.daisy.settings.updateServerPresentation({ serverId: server.id, changes }).then(
      (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
      (error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : 'Could not save host',
      }),
    );
  }

  function armRowSave(): void {
    // A staged confirmation is cancelled by a *different* value, not by the
    // act of an event: clicking the banner's own Apply button blurs the origin
    // field and the resulting native `change` reaches here with the identical
    // value. Disarming on that event would wipe the two-click confirmation as
    // soon as Apply had armed it, making the confirm flow impossible to
    // complete. So an origin prompt survives a re-commit of the same origin
    // (the debounced run re-affirms it), and only a genuine change disarms.
    const currentOrigin = hasOriginChange();
    if (pendingOrigin !== undefined && currentOrigin !== pendingOrigin) {
      pendingOrigin = undefined;
      ctx.status.clear();
    }
    if (removeArmed) {
      // A removal warning has no value to reconcile against - any edit voids
      // it. (The Remove click itself does not reach here: the field blur it
      // causes fires this listener *before* the button's own handler arms.)
      removeArmed = false;
      ctx.status.clear();
    }
    autoSave.arm(() => {
      const outcome = runRowSave();
      if (outcome === undefined) return;
      ctx.reportSave(outcome);
      void outcome.then((result) => {
        if (result.ok) ctx.onSettingsChanged();
      });
    });
  }

  for (const field of [labelField, originField]) {
    field.addEventListener('input', armRowSave);
    field.addEventListener('change', armRowSave);
  }

  function reportMutation(outcome: Promise<SaveOutcome>, onSettled: () => void): void {
    // The reporter's settle is attached before our continuations, so a drain
    // that empties the batch is announced before the reload below re-renders
    // the section from the fresh snapshot.
    ctx.reportSave(outcome);
    void outcome.then(
      (result) => {
        if (result.ok) ctx.onSettingsChanged();
      },
      () => undefined,
    );
    // Re-enable the controls only once the IPC has fully settled - a
    // second click during the round trip must stay inert.
    void outcome.then(onSettled, onSettled);
  }

  function persistOrigin(origin: string): void {
    if (busy) return;
    setBusy(true);
    // The confirmation clicks themselves blurred the fields and re-armed a
    // debounced save; drop it - `origin` is already being persisted here, and
    // letting that run fire would re-raise the change warning we just acted on.
    autoSave.cancel();
    reportMutation(
      window.daisy.settings
        .updateServerTargeting({
          serverId: server.id,
          changes: { origin },
          originChangeConfirmed: true,
        })
        .then(
          (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
          (error: unknown) => ({
            ok: false,
            error: error instanceof Error ? error.message : 'Could not change the address',
          }),
        ),
      () => setBusy(false),
    );
  }

  function persistRemoval(): void {
    if (busy) return;
    setBusy(true);
    autoSave.cancel();
    reportMutation(
      window.daisy.settings.removeServer({ serverId: server.id }).then(
        (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not remove host',
        }),
      ),
      () => setBusy(false),
    );
  }

  removeButton.addEventListener('click', () => {
    if (busy) return;
    // Removing the currently-active server is handled on the main side
    // (`settingsStore.ts`'s `removeServer`): it clears `activeServerId`
    // rather than leaving a dangling reference.
    pendingOrigin = undefined;
    removeArmed = true;
    ctx.status.showPrompt('Confirm removing the host. This action cannot be undone', removeAction);
  });

  const children: HTMLElement[] = [
    heading,
    el('div', {
      attrs: { class: 'server-row__fields' },
      children: [labelField, colorPicker.element, originField],
    }),
    proxyLine,
  ];
  if (server.proxy) {
    const passwordEntry = createPasswordEntry({ kind: 'server', serverId: server.id }, ctx.status);
    passwordEntry.onChanged(() => ctx.onSettingsChanged());
    children.push(passwordEntry.element);
  }
  children.push(el('div', { attrs: { class: 'server-row__actions' }, children: [removeButton] }));

  const element = el('li', { attrs: { class: 'server-row' }, children });

  return {
    element,
    async flushNow(): Promise<void> {
      await autoSave.flushNow();
    },
    isInProgress(): boolean {
      return autoSave.hasPending() || pendingOrigin !== undefined || removeArmed;
    },
    dispose(): void {
      autoSave.dispose();
    },
  };
}

export interface HostsSectionOptions {
  /** The panel's single status slot. */
  status: StatusBannerSink;
  /** Registers debounced/confirming saves with the panel's save reporter. */
  reportSave(outcome: Promise<SaveOutcome>): void;
  /** Fired after any successful mutation so the panel re-reads the snapshot. */
  onSettingsChanged(): void;
}

export interface HostsSection {
  readonly element: HTMLElement;
  update(servers: readonly ServerSnapshot[]): void;
  flushNow(): Promise<void>;
  hasPendingEdits(): boolean;
  dispose(): void;
}

/**
 * The hosts section (requirements-decisions.md sections 3, 4, 8): the
 * configured host list plus an add-host form. Mutation outcomes are shown
 * on the panel's banner (`status`); the two actions that need a separate
 * warning - changing an address, deleting a host - get one there and never
 * auto-apply (see `buildServerRow`).
 *
 * Configuring a server's AEM proxy (address/username) is deliberately not
 * part of the row or the add form here: `settings:add-server` never accepted proxy
 * fields (a fresh server is created presentation-only; see
 * `addServerRequestSchema`'s own doc comment), and this step does not add an
 * edit UI for `updateServerTargeting`'s `proxy` field either, because that
 * field's `credentials.secretRef` is minted by main and never handed to the
 * renderer - there is nothing a form here could safely fill in for it. The
 * add form still accepts an optional proxy address/username (kept
 * from before this step) purely as client-side-validated input; on a
 * successful add it reports plainly that those two fields were not saved,
 * rather than silently discarding what the user typed.
 */
export function createHostsSection(options: HostsSectionOptions): HostsSection {
  const list = el('ul', { attrs: { class: 'server-list' } });
  let rows: ServerRowHandle[] = [];

  function replaceRows(servers: readonly ServerSnapshot[]): void {
    for (const row of rows) row.dispose();
    rows = servers.map((server) => buildServerRow(server, options));
    list.replaceChildren(...rows.map((row) => row.element));
  }

  const labelField = el('sp-textfield', { attrs: { placeholder: 'Label' } }) as TextField;
  const originField = el('sp-textfield', {
    attrs: { placeholder: 'https://author.example' },
  }) as TextField;
  const colorPicker = createColorPicker();
  const proxyOriginField = el('sp-textfield', {
    attrs: { placeholder: 'AEM proxy address (optional, not saved yet)' },
  }) as TextField;
  const proxyUsernameField = el('sp-textfield', {
    attrs: { placeholder: 'Proxy username (optional, not saved yet)' },
  }) as TextField;
  const addButton = el('sp-button', { attrs: { variant: 'accent' }, text: 'Add host' });

  addButton.addEventListener('click', () => {
    const result = validateNewServerForm({
      label: labelField.value,
      origin: originField.value,
      color: colorPicker.read(),
      proxyOrigin: proxyOriginField.value,
      proxyUsername: proxyUsernameField.value,
    });
    if (!result.ok) {
      options.status.showError(Object.values(result.errors).filter(Boolean).join(' | '));
      return;
    }
    addButton.setAttribute('disabled', '');
    void window.daisy.settings
      .addServer({
        label: result.value.label,
        origin: result.value.origin,
        color: result.value.color,
      })
      .then((addResult) => {
        if (!addResult.ok) {
          options.status.showError(addResult.error.message);
          return;
        }
        labelField.value = '';
        originField.value = '';
        proxyOriginField.value = '';
        proxyUsernameField.value = '';
        colorPicker.setValue({ kind: 'swatch', swatch: SERVER_SWATCHES[0] });
        options.status.showStatus('Host added');
        options.onSettingsChanged();
      })
      .catch((error: unknown) => {
        options.status.showError(error instanceof Error ? error.message : 'Could not add host');
      })
      .finally(() => addButton.removeAttribute('disabled'));
  });

  const form = el('div', {
    attrs: { class: 'add-server-form' },
    children: [
      labelField,
      originField,
      colorPicker.element,
      proxyOriginField,
      proxyUsernameField,
      addButton,
    ],
  });

  const element = el('section', {
    attrs: { class: 'settings-section', 'aria-label': 'Hosts' },
    children: [list, el('h2', { text: 'Add a host' }), form],
  });

  /** Flushing an armed-but-never-saved save (e.g. close) is harmless and loses nothing. */
  return {
    element,
    update(servers: readonly ServerSnapshot[]): void {
      replaceRows(servers);
    },
    async flushNow(): Promise<void> {
      for (const row of rows) {
        await row.flushNow();
      }
    },
    hasPendingEdits: () => rows.some((row) => row.isInProgress()),
    dispose(): void {
      for (const row of rows) row.dispose();
      rows = [];
    },
  };
}
