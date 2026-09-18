import { el } from '../lib/dom';
import { createMultifield } from '../lib/multifield';
import {
  type ServerColor,
  type ServerId,
  type ServerSnapshot,
  type ServerSwatch,
} from '../../../shared';
import { colorKey, createColorPicker } from './colorPicker';
import { createAutoSave } from './autoSave';
import type { SaveOutcome, StatusBannerAction, StatusBannerSink } from './statusBanner';
import { resolveHostLabelInput, validateHostColorInput, validateOriginInput } from './viewModel';

type TextField = HTMLElement & { value: string };

/** A fresh host's colour, per the settings UI's agreed default swatch. */
const DEFAULT_SWATCH: ServerSwatch = 'blue';
const DEFAULT_COLOR: ServerColor = { kind: 'swatch', swatch: DEFAULT_SWATCH };

/** Everything a host item needs from the section (and, one level up, the panel). */
interface HostItemContext {
  status: StatusBannerSink;
  reportSave(outcome: Promise<SaveOutcome>): void;
  onSettingsChanged(): void;
  /** Removes the item's row from the multifield (after confirmation, for a saved host). */
  removeRow(key: string): void;
}

interface HostItemHandle {
  readonly key: string;
  /** The item's field block - the multifield's "slot" content. */
  readonly element: HTMLElement;
  /** The persisted server id, or `undefined` while this is an unsaved draft. */
  serverId(): ServerId | undefined;
  /** Asks for removal (drafts remove immediately; saved hosts arm the banner confirmation). */
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

interface AddressValidation {
  readonly ok: boolean;
  readonly origin: string;
  readonly error: string | undefined;
}

interface LabelValidation {
  readonly ok: boolean;
  readonly label: string;
  readonly error: string | undefined;
}

interface ColorValidation {
  readonly ok: boolean;
  readonly color: ServerColor | undefined;
  readonly error: string | undefined;
}

/**
 * One host row - a draft (no `serverId`) or an existing server. Its three
 * fields are always editable in place and auto-save (~1s after the last edit)
 * with no Save button.
 *
 * The address is the exception, exactly as the plan requires: changing a
 * server's origin needs a *separate* warning and confirmation
 * (requirements-decisions.md section 7), so an address edit never applies by
 * the debounce alone. The confirmation is staged in the panel's banner and a
 * single OK click persists it; the staged prompt is reconciled against the
 * field's *value*, so typing a different address (or reverting) re-raises or
 * cancels it on the next debounce, while the blur "change" that clicking OK
 * itself causes re-commits the same value and must not wipe the confirmation.
 *
 * A draft has no server to target yet: its first *valid* save calls
 * `settings:add-server`, and the host is created at the end of the list (the
 * multifield only reorders already-persisted hosts).
 */
function buildHostItem(
  server: ServerSnapshot | undefined,
  key: string,
  fieldIdBase: string,
  ctx: HostItemContext,
): HostItemHandle {
  const addressFieldId = `${fieldIdBase}-address`;
  const labelFieldId = `${fieldIdBase}-label`;
  const colorFieldId = `${fieldIdBase}-color`;

  const addressField = el('sp-textfield', {
    attrs: {
      id: addressFieldId,
      class: 'host-field__input',
      placeholder: 'https://author.example',
      'aria-label': 'Address',
    },
  }) as TextField;
  addressField.value = server?.origin ?? '';
  const addressHelp = el('span', { attrs: { slot: 'negative-help-text' } });
  addressField.append(addressHelp);

  const labelField = el('sp-textfield', {
    attrs: {
      id: labelFieldId,
      class: 'host-field__input',
      placeholder: 'Defaults to the address',
      'aria-label': 'Label',
    },
  }) as TextField;
  labelField.value = server?.label ?? '';
  const labelHelp = el('span', { attrs: { slot: 'negative-help-text' } });
  labelField.append(labelHelp);

  const colorPicker = createColorPicker({
    fieldId: colorFieldId,
    initial: server?.color ?? DEFAULT_COLOR,
    onInput: armItemSave,
  });

  const fields = el('div', {
    attrs: { class: 'host-item__fields' },
    children: [
      el('div', {
        attrs: { class: 'host-field' },
        children: [
          // No `required` on the label: `sp-field-label` renders that as an
          // asterisk, and the agreed copy spells it out as "(required)".
          el('sp-field-label', { attrs: { for: addressFieldId }, text: 'Address (required)' }),
          addressField,
        ],
      }),
      el('div', {
        attrs: { class: 'host-field' },
        children: [
          el('sp-field-label', { attrs: { for: labelFieldId }, text: 'Label' }),
          labelField,
        ],
      }),
      el('div', {
        attrs: { class: 'host-field' },
        children: [
          el('sp-field-label', { attrs: { for: colorFieldId }, text: 'Color tag' }),
          colorPicker.element,
        ],
      }),
    ],
  });

  const autoSave = createAutoSave();

  let serverId: ServerId | undefined = server?.id;
  let savedOrigin = server?.origin ?? '';
  let savedLabel = server?.label ?? '';
  let savedColorKey = colorKey(server?.color ?? DEFAULT_COLOR);

  /** The exact origin the user has been warned about; the OK click persists it. */
  let pendingOrigin: string | undefined;
  /** Whether the remove warning is showing and the OK button is live. */
  let removeArmed = false;
  let busy = false;

  function refreshAddress(): AddressValidation {
    const result = validateOriginInput(addressField.value);
    setInvalid(addressField, addressHelp, result.ok ? undefined : result.error);
    return result.ok
      ? { ok: true, origin: result.origin, error: undefined }
      : { ok: false, origin: '', error: result.error };
  }

  function refreshLabel(origin: string): LabelValidation {
    const result = resolveHostLabelInput(labelField.value, origin);
    setInvalid(labelField, labelHelp, result.ok ? undefined : result.error);
    return result.ok
      ? { ok: true, label: result.label, error: undefined }
      : { ok: false, label: '', error: result.error };
  }

  function refreshColor(): ColorValidation {
    const result = validateHostColorInput(colorPicker.read());
    colorPicker.setError(result.ok ? undefined : result.error);
    return result.ok
      ? { ok: true, color: result.value, error: undefined }
      : { ok: false, color: undefined, error: result.error };
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
   * Runs one save with the item's current values. Returns the outcome promise
   * for the reportSave wiring, or `undefined` when nothing was saved
   * (validation failed - already shown - or there is nothing dirty).
   */
  function runSave(): Promise<SaveOutcome> | undefined {
    if (busy) return undefined;

    const address = refreshAddress();
    if (!address.ok) return undefined;
    const label = refreshLabel(address.origin);
    const color = refreshColor();
    if (!label.ok || !color.ok || color.color === undefined) return undefined;

    if (serverId === undefined) {
      return window.daisy.settings
        .addServer({ label: label.label, origin: address.origin, color: color.color })
        .then(
          (result) => {
            if (!result.ok) return { ok: false, error: result.error.message };
            serverId = result.server.id;
            savedOrigin = result.server.origin;
            savedLabel = result.server.label;
            savedColorKey = colorKey(result.server.color);
            return { ok: true };
          },
          (error: unknown) => ({
            ok: false,
            error: error instanceof Error ? error.message : 'Could not add host',
          }),
        );
    }

    // A removal confirmation is showing; nothing this run would save still
    // matters (the row is going away), and re-raising the origin warning here
    // would clobber the removal prompt.
    if (removeArmed) return undefined;

    const id = serverId;
    const changedOrigin = address.origin !== savedOrigin ? address.origin : undefined;
    if (changedOrigin !== undefined) {
      showOriginPrompt(changedOrigin);
    } else if (pendingOrigin !== undefined) {
      // The user put the address back; the staged confirmation is void.
      pendingOrigin = undefined;
      ctx.status.clear();
    }

    const nextLabel = label.label;
    const nextColor = color.color;
    if (nextLabel === savedLabel && colorKey(nextColor) === savedColorKey) return undefined;

    const changes: { label: string; color: ServerColor } = { label: nextLabel, color: nextColor };
    const outcome: Promise<SaveOutcome> = window.daisy.settings
      .updateServerPresentation({ serverId: id, changes })
      .then(
        (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not save host',
        }),
      );
    void outcome.then((result) => {
      if (result.ok) {
        savedLabel = nextLabel;
        savedColorKey = colorKey(nextColor);
      }
    });
    return outcome;
  }

  function armItemSave(): void {
    // A staged confirmation is cancelled by a *different* value, not by the
    // act of an event: clicking the banner's own OK button blurs the address
    // field and the resulting native `change` reaches here with the identical
    // value. Disarming on that event would wipe the single-click confirmation
    // as soon as it had armed it, making the confirm flow impossible to
    // complete. So an origin prompt survives a re-commit of the same origin
    // (the debounced run re-affirms it), and only a genuine change disarms.
    const addressResult = validateOriginInput(addressField.value);
    const currentOrigin = addressResult.ok ? addressResult.origin : undefined;
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

    // Immediate inline feedback, before the debounced save.
    refreshAddress();
    refreshLabel(addressResult.ok ? addressResult.origin : '');
    refreshColor();

    autoSave.arm(() => {
      const outcome = runSave();
      if (outcome === undefined) return;
      ctx.reportSave(outcome);
      void outcome.then((result) => {
        if (result.ok) ctx.onSettingsChanged();
      });
    });
  }

  for (const field of [addressField, labelField]) {
    field.addEventListener('input', armItemSave);
    field.addEventListener('change', armItemSave);
  }

  function reportMutation(
    outcome: Promise<SaveOutcome>,
    onSettled: () => void,
    onSuccess: () => void,
  ): void {
    // The reporter's settle is attached before our continuations, so a drain
    // that empties the batch is announced before the reload below re-renders
    // the section from the fresh snapshot.
    ctx.reportSave(outcome);
    void outcome.then((result) => {
      if (result.ok) {
        onSuccess();
        ctx.onSettingsChanged();
      }
    });
    // Re-enable the controls only once the IPC has fully settled - a second
    // click during the round trip must stay inert.
    void outcome.then(onSettled, onSettled);
  }

  function persistOrigin(origin: string): void {
    if (busy || serverId === undefined) return;
    const id = serverId;
    busy = true;
    // The confirmation clicks themselves blurred the fields and re-armed a
    // debounced save; drop it - `origin` is already being persisted here, and
    // letting that run fire would re-raise the change warning we just acted on.
    autoSave.cancel();
    reportMutation(
      window.daisy.settings
        .updateServerTargeting({
          serverId: id,
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
      () => {
        busy = false;
      },
      () => {
        savedOrigin = origin;
      },
    );
  }

  function persistRemoval(): void {
    if (busy) return;
    const id = serverId;
    if (id === undefined) {
      ctx.removeRow(key);
      return;
    }
    busy = true;
    autoSave.cancel();
    reportMutation(
      window.daisy.settings.removeServer({ serverId: id }).then(
        (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not remove host',
        }),
      ),
      () => {
        busy = false;
      },
      () => ctx.removeRow(key),
    );
  }

  function requestRemoval(): void {
    if (busy) return;
    if (serverId === undefined) {
      // A draft has nothing persisted to lose; removing it needs no confirmation.
      ctx.removeRow(key);
      return;
    }
    // Removing the currently-active server is handled on the main side
    // (`settingsStore.ts`'s `removeServer`): it clears `activeServerId` rather
    // than leaving a dangling reference.
    pendingOrigin = undefined;
    removeArmed = true;
    ctx.status.showPrompt('Confirm removing the host. This action cannot be undone', removeAction);
  }

  return {
    key,
    element: fields,
    serverId: () => serverId,
    requestRemoval,
    isInProgress(): boolean {
      // A draft is unsaved work by definition - it must not be clobbered by a
      // snapshot re-read triggered from anywhere else in the panel.
      if (serverId === undefined) return true;
      return autoSave.hasPending() || pendingOrigin !== undefined || removeArmed;
    },
    flushNow(): Promise<void> {
      return autoSave.flushNow();
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
 * The hosts section (requirements-decisions.md sections 3, 4, 8): a multifield
 * of configured hosts plus an "Add item" action. The per-item rules live in
 * `buildHostItem`; the multifield chrome (one row per line, labelled fields,
 * up/down/remove actions, "Add item") lives in the reusable
 * `lib/multifield.ts`.
 *
 * Reordering is persisted too: moving a row up/down sends the complete new
 * order of the *persisted* hosts to `settings:reorder-servers` (a draft has no
 * id yet, and the first valid save creates it at the end of the list).
 *
 * AEM proxy configuration is deliberately absent here for now: the field set
 * is Address/Label/Color tag only, and the proxy UI will be reintroduced
 * separately.
 */
export function createHostsSection(options: HostsSectionOptions): HostsSection {
  let items = new Map<string, HostItemHandle>();
  let lastPersistedOrder: readonly ServerId[] = [];
  let draftSeq = 0;
  let fieldSeq = 0;

  const itemContext: HostItemContext = {
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

  function sameOrder(order: readonly ServerId[]): boolean {
    return (
      order.length === lastPersistedOrder.length &&
      order.every((id, index) => id === lastPersistedOrder[index])
    );
  }

  /** The persisted hosts' current visual order (drafts excluded). */
  function currentSavedOrder(): ServerId[] {
    return multifield
      .keys()
      .map((key) => items.get(key)?.serverId())
      .filter((id): id is ServerId => id !== undefined);
  }

  function persistOrder(): void {
    const order = currentSavedOrder();
    // Reordering draft rows cannot change the persisted order (a draft has no
    // id); only a genuine change to the persisted hosts is worth an IPC write.
    if (order.length < 2 || sameOrder(order)) return;

    const outcome: Promise<SaveOutcome> = window.daisy.settings
      .reorderServers({ serverIds: order })
      .then(
        (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not reorder hosts',
        }),
      );
    options.reportSave(outcome);
    void outcome.then((result) => {
      if (!result.ok) return;
      lastPersistedOrder = order;
      // Deliberately no `onSettingsChanged()`: a reload would rebuild every row
      // from the snapshot and drop the focus/accent on the field the user just
      // moved. The list already shows the new order, and this call persisted it;
      // the shell's host-picker order follows on the next natural reload.
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
    const handle = buildHostItem(undefined, key, `host-${String(++fieldSeq)}`, itemContext);
    items.set(key, handle);
    multifield.append({ key, element: handle.element });
    // Best effort: focus the new draft's address input so the user can type
    // immediately. The real Spectrum field has a shadow input; jsdom does not.
    handle.element.querySelector('input')?.focus();
  }

  function replaceItems(servers: readonly ServerSnapshot[]): void {
    for (const item of items.values()) item.dispose();
    items = new Map();
    multifield.clear();
    for (const server of servers) {
      const key = `server:${server.id}`;
      const handle = buildHostItem(server, key, `host-${String(++fieldSeq)}`, itemContext);
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
    attrs: { class: 'settings-section hosts-section', 'aria-label': 'Hosts' },
    children: [multifield.element],
  });

  return {
    element,
    update(servers: readonly ServerSnapshot[]): void {
      lastPersistedOrder = servers.map((server) => server.id);
      if (hasPendingEdits()) return;
      replaceItems(servers);
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
