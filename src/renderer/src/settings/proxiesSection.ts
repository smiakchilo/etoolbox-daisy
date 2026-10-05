import { BANNER_ACTION_MARKER } from '../lib/alertBanner';
import { containsFocus, el } from '../lib/dom';
import { createMultifield } from '../lib/multifield';
import { type ProxyId, type ProxySnapshot } from '../../../shared';
import { createAutoSave } from './autoSave';
import { createPasswordControl } from './passwordEntry';
import type { SaveOutcome, StatusBannerAction, StatusBannerSink } from './statusBanner';
import { resolveHostLabelInput, validateOriginInput } from './viewModel';

type TextField = HTMLElement & { value: string };

/** Everything a proxy item needs from the section (and, one level up, the panel). */
interface ProxyItemContext {
  status: StatusBannerSink;
  reportSave(outcome: Promise<SaveOutcome>): void;
  onSettingsChanged(): void;
  /** Removes the item's row from the multifield (after confirmation, for a saved proxy). */
  removeRow(key: string): void;
}

interface ProxyItemHandle {
  readonly key: string;
  /** The item's field block - the multifield's "slot" content. */
  readonly element: HTMLElement;
  /** The persisted proxy id, or `undefined` while this is an unsaved draft. */
  proxyId(): ProxyId | undefined;
  /** Asks for removal (drafts remove immediately; saved proxies arm the banner confirmation). */
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
 * One proxy row - a draft (no `proxyId`) or an existing library entry. Its
 * label/address/username auto-save (~1s after the last edit) with no Save
 * button, exactly like a host; the password is the deliberate exception,
 * kept behind explicit Set/Clear buttons (see `passwordEntry.ts`).
 *
 * Unlike a host's address, changing a proxy's address needs no confirmation:
 * no live connection is bound to a library entry yet (which entry the Copilot
 * runtime uses is a selection concern deferred to a later step), so the
 * debounced save applies immediately.
 *
 * A draft has no entry to target yet: its first *valid* save calls
 * `settings:add-proxy`, and the entry is created at the end of the list (the
 * multifield only reorders already-persisted entries).
 */
function buildProxyItem(
  proxy: ProxySnapshot | undefined,
  key: string,
  fieldIdBase: string,
  ctx: ProxyItemContext,
): ProxyItemHandle {
  const addressFieldId = `${fieldIdBase}-address`;
  const labelFieldId = `${fieldIdBase}-label`;
  const usernameFieldId = `${fieldIdBase}-username`;

  const addressField = el('sp-textfield', {
    attrs: {
      id: addressFieldId,
      class: 'host-field__input',
      placeholder: 'https://proxy.example:8080',
      'aria-label': 'Address',
    },
  }) as TextField;
  addressField.value = proxy?.url ?? '';
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
  labelField.value = proxy?.label ?? '';
  const labelHelp = el('span', { attrs: { slot: 'negative-help-text' } });
  labelField.append(labelHelp);

  const usernameField = el('sp-textfield', {
    attrs: {
      id: usernameFieldId,
      class: 'host-field__input',
      placeholder: 'Optional username',
      'aria-label': 'User name',
    },
  }) as TextField;
  usernameField.value = proxy?.credentials?.username ?? '';

  let proxyId: ProxyId | undefined = proxy?.id;

  const passwordControl = createPasswordControl(
    {
      target: () => (proxyId === undefined ? undefined : { kind: 'proxy', proxyId }),
      onChanged: () => ctx.onSettingsChanged(),
    },
    ctx.status,
  );

  const fields = el('div', {
    attrs: { class: 'host-item__fields' },
    children: [
      labelledField(addressFieldId, 'Address (required)', addressField),
      labelledField(labelFieldId, 'Label', labelField),
      labelledField(usernameFieldId, 'User name', usernameField),
      labelledField('', 'Password', passwordControl.element),
    ],
  });

  const autoSave = createAutoSave();

  let savedLabel = proxy?.label ?? '';
  let savedUrl = proxy?.url ?? '';
  let savedUsername = proxy?.credentials?.username ?? '';
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

  /**
   * Runs one save with the item's current values. Returns the outcome promise
   * for the reportSave wiring, or `undefined` when nothing was saved
   * (validation failed - already shown - or there is nothing dirty).
   */
  function runSave(): Promise<SaveOutcome> | undefined {
    if (busy) return undefined;

    const address = validateOriginInput(addressField.value);
    setInvalid(addressField, addressHelp, address.ok ? undefined : address.error);
    if (!address.ok) return undefined;

    const label = resolveHostLabelInput(labelField.value, address.origin);
    setInvalid(labelField, labelHelp, label.ok ? undefined : label.error);
    if (!label.ok) return undefined;

    const username = usernameField.value.trim();

    if (proxyId === undefined) {
      return window.daisy.settings
        .addProxy({
          label: label.label,
          url: address.origin,
          ...(username !== '' ? { username } : {}),
        })
        .then(
          (result) => {
            if (!result.ok) return { ok: false, error: result.error.message };
            proxyId = result.proxy.id;
            savedLabel = result.proxy.label;
            savedUrl = result.proxy.url;
            savedUsername = result.proxy.credentials?.username ?? '';
            return { ok: true };
          },
          (error: unknown) => ({
            ok: false,
            error: error instanceof Error ? error.message : 'Could not add proxy',
          }),
        );
    }

    // A removal confirmation is showing; nothing this run would save still
    // matters (the row is going away).
    if (removeArmed) return undefined;

    if (label.label === savedLabel && address.origin === savedUrl && username === savedUsername) {
      return undefined;
    }

    const outcome: Promise<SaveOutcome> = window.daisy.settings
      .updateProxy({
        proxyId,
        label: label.label,
        url: address.origin,
        ...(username !== '' ? { username } : {}),
      })
      .then(
        (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not save proxy',
        }),
      );
    void outcome.then((result) => {
      if (result.ok) {
        savedLabel = label.label;
        savedUrl = address.origin;
        savedUsername = username;
      }
    });
    return outcome;
  }

  function armItemSave(): void {
    if (removeArmed) {
      // A removal warning has no value to reconcile against - any edit voids
      // it. (The Remove click itself does not reach here: the field blur it
      // causes fires this listener *before* the button's own handler arms.)
      removeArmed = false;
      ctx.status.clear();
    }

    // Immediate inline feedback, before the debounced save.
    const address = validateOriginInput(addressField.value);
    setInvalid(addressField, addressHelp, address.ok ? undefined : address.error);
    const label = resolveHostLabelInput(labelField.value, address.ok ? address.origin : '');
    setInvalid(labelField, labelHelp, label.ok ? undefined : label.error);

    autoSave.arm(() => {
      const outcome = runSave();
      if (outcome === undefined) return;
      ctx.reportSave(outcome);
      void outcome.then((result) => {
        if (result.ok) ctx.onSettingsChanged();
      });
    });
  }

  for (const field of [addressField, labelField, usernameField]) {
    field.addEventListener('input', armItemSave);
    field.addEventListener('change', armItemSave);
  }

  function persistRemoval(): void {
    if (busy) return;
    const id = proxyId;
    if (id === undefined) {
      ctx.removeRow(key);
      return;
    }
    busy = true;
    autoSave.cancel();
    const outcome: Promise<SaveOutcome> = window.daisy.settings.removeProxy({ proxyId: id }).then(
      (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
      (error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : 'Could not remove proxy',
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
    if (proxyId === undefined) {
      // A draft has nothing persisted to lose; removing it needs no confirmation.
      ctx.removeRow(key);
      return;
    }
    removeArmed = true;
    ctx.status.showPrompt(
      `Removing the proxy cannot be undone. Press ${BANNER_ACTION_MARKER} to remove it`,
      removeAction,
    );
  }

  return {
    key,
    element: fields,
    proxyId: () => proxyId,
    requestRemoval,
    isInProgress(): boolean {
      // A draft is unsaved work by definition - it must not be clobbered by a
      // snapshot re-read triggered from anywhere else in the panel.
      if (proxyId === undefined) return true;
      return autoSave.hasPending() || removeArmed;
    },
    flushNow(): Promise<void> {
      return autoSave.flushNow();
    },
    dispose(): void {
      autoSave.dispose();
    },
  };
}

export interface ProxiesSectionOptions {
  /** The panel's single status slot. */
  status: StatusBannerSink;
  /** Registers debounced/confirming saves with the panel's save reporter. */
  reportSave(outcome: Promise<SaveOutcome>): void;
  /** Fired after any successful mutation so the panel re-reads the snapshot. */
  onSettingsChanged(): void;
}

export interface ProxiesSection {
  readonly element: HTMLElement;
  update(proxies: readonly ProxySnapshot[]): void;
  flushNow(): Promise<void>;
  hasPendingEdits(): boolean;
  dispose(): void;
}

/**
 * The proxies section: a multifield of configured proxy-library entries plus
 * an "Add item" action. The per-item rules live in `buildProxyItem`; the
 * multifield chrome (one row per line, labelled fields, up/down/remove
 * actions, "Add item") lives in the reusable `lib/multifield.ts`, exactly as
 * the Hosts tab uses it.
 *
 * Reordering is persisted: moving a row up/down sends the complete new order
 * of the *persisted* entries to `settings:reorder-proxies` (a draft has no id
 * yet, and the first valid save creates it at the end of the list).
 */
export function createProxiesSection(options: ProxiesSectionOptions): ProxiesSection {
  let items = new Map<string, ProxyItemHandle>();
  let lastPersistedOrder: readonly ProxyId[] = [];
  let draftSeq = 0;
  let fieldSeq = 0;

  const itemContext: ProxyItemContext = {
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

  function sameOrder(order: readonly ProxyId[]): boolean {
    return (
      order.length === lastPersistedOrder.length &&
      order.every((id, index) => id === lastPersistedOrder[index])
    );
  }

  /** The persisted proxies' current visual order (drafts excluded). */
  function currentSavedOrder(): ProxyId[] {
    return multifield
      .keys()
      .map((key) => items.get(key)?.proxyId())
      .filter((id): id is ProxyId => id !== undefined);
  }

  function persistOrder(): void {
    const order = currentSavedOrder();
    // Reordering draft rows cannot change the persisted order (a draft has no
    // id); only a genuine change to the persisted entries is worth an IPC write.
    if (order.length < 2 || sameOrder(order)) return;

    const outcome: Promise<SaveOutcome> = window.daisy.settings
      .reorderProxies({ proxyIds: order })
      .then(
        (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not reorder proxies',
        }),
      );
    options.reportSave(outcome);
    void outcome.then((result) => {
      if (!result.ok) return;
      lastPersistedOrder = order;
      // Deliberately no `onSettingsChanged()`: a reload would rebuild every row
      // from the snapshot and drop the focus/accent on the field the user just
      // moved. The list already shows the new order, and this call persisted it.
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
    const handle = buildProxyItem(undefined, key, `proxy-${String(++fieldSeq)}`, itemContext);
    items.set(key, handle);
    multifield.append({ key, element: handle.element });
    // Best effort: focus the new draft's address input so the user can type
    // immediately. The real Spectrum field has a shadow input; jsdom does not.
    handle.element.querySelector('input')?.focus();
  }

  function replaceItems(proxies: readonly ProxySnapshot[]): void {
    for (const item of items.values()) item.dispose();
    items = new Map();
    multifield.clear();
    for (const proxy of proxies) {
      const key = `proxy:${proxy.id}`;
      const handle = buildProxyItem(proxy, key, `proxy-${String(++fieldSeq)}`, itemContext);
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
    attrs: { class: 'settings-section proxies-section', 'aria-label': 'Proxies' },
    children: [multifield.element],
  });

  return {
    element,
    update(proxies: readonly ProxySnapshot[]): void {
      lastPersistedOrder = proxies.map((proxy) => proxy.id);
      if (hasPendingEdits()) return;
      // A rebuild detaches the focused field and drops the caret. The reload
      // that follows this very auto-save would therefore interrupt the user
      // mid-typing, making the "Settings saved" row look like it stole focus.
      // The live rows already show the user's committed edit, so nothing is
      // lost by waiting for focus to leave the section before rebuilding.
      if (containsFocus(element)) return;
      replaceItems(proxies);
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
