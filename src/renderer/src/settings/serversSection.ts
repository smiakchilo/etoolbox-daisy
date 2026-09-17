import { el } from '../lib/dom';
import { resolveServerColorCss } from '../lib/serverColor';
import {
  isInsecureOrigin,
  SERVER_SWATCHES,
  type ServerColor,
  type ServerSnapshot,
} from '../../../shared';
import { createPasswordEntry } from './passwordEntry';
import {
  describeProxySnapshot,
  validateEditServerForm,
  validateNewServerForm,
  validateOriginInput,
} from './viewModel';

type TextField = HTMLElement & { value: string };
type CheckboxElement = HTMLElement & { checked: boolean };

const SWATCH_SET = new Set<string>(SERVER_SWATCHES);

/**
 * The colour picker shared by the add-server form and each row's inline edit
 * form: a plain, always-typable `sp-textfield` (holding either a swatch name
 * like `blue` or a `#rrggbb` hex string) plus an `sp-action-menu` "picker
 * button" beside it listing the named swatches with their colour dots.
 * Selecting an item writes that swatch's name into the field - the exact
 * same textfield-plus-picker-button pattern as the browser toolbar's address
 * bar/server picker (`browserToolbar.ts`), chosen for the same reason: it
 * keeps the field itself as the single source of truth and typable at all
 * times, with the menu as a pure convenience for the common case. Unlike
 * that address bar, this button never needs to hide - `SERVER_SWATCHES` is a
 * fixed, always-non-empty list - so there is no `[hidden]` handling here.
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
    attrs: { placeholder: '#2680eb or a swatch name', 'aria-label': 'Colour' },
  }) as TextField;

  const colorMenuButton = el('sp-action-menu', {
    attrs: { class: 'color-picker-button', quiet: '', label: 'Choose colour' },
  }) as HTMLElement & { value: string };
  const colorMenuIcon = document.createElement('sp-icon-chevron-down');
  colorMenuIcon.setAttribute('slot', 'icon');
  colorMenuButton.append(
    colorMenuIcon,
    ...SERVER_SWATCHES.map((swatch) => {
      const dot = el('span', { attrs: { class: 'server-swatch', role: 'presentation' } });
      dot.style.backgroundColor = resolveServerColorCss({ kind: 'swatch', swatch });
      dot.setAttribute('slot', 'icon');
      return el('sp-menu-item', { attrs: { value: swatch }, text: swatch, children: [dot] });
    }),
  );

  // Same reasoning as `serverMenuButton.addEventListener("change", ...)` in
  // browserToolbar.ts: selecting an item just writes its value into the
  // field, then the field is the only thing read back.
  colorMenuButton.addEventListener('change', () => {
    const value = colorMenuButton.value.trim();
    if (value === '') return;
    colorField.value = value;
    onInput?.();
  });

  if (onInput) {
    colorField.addEventListener('input', onInput);
    colorField.addEventListener('change', onInput);
  }

  function setValue(color: ServerColor): void {
    colorField.value = color.kind === 'custom' ? color.hex : color.swatch;
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

/**
 * One server row: its label, colour and address are always editable in place,
 * and the row has exactly two buttons - Save and Remove.
 *
 * Save stays disabled until at least one of the three fields differs from the
 * saved server, and then applies only what is dirty: label/colour through
 * `updateServerPresentation`, the address through `updateServerTargeting`.
 *
 * The two actions requirements-decisions.md section 7 requires a *separate*
 * warning and confirmation for - changing a server's address, and deleting a
 * server - get one without a second button: the first click only warns and
 * arms that same button, and a second click on it applies the change. Editing
 * any field disarms it again, because the warning named values that are no
 * longer the ones on screen. There is no modal dialog framework in this
 * renderer, so the confirmation is this two-click step rather than a dialog.
 */
function buildServerRow(server: ServerSnapshot, onSettingsChanged: () => void): HTMLElement {
  const swatch = el('span', { attrs: { class: 'server-swatch', role: 'presentation' } });
  swatch.style.backgroundColor = resolveServerColorCss(server.color);

  const heading = el('h3', { attrs: { class: 'server-row__heading' }, children: [swatch] });
  heading.append(document.createTextNode(` ${server.label}`));

  const proxyLine = el('p', { text: `AEM proxy: ${describeProxySnapshot(server.proxy)}` });

  // Colour never carries this fact alone (requirements-decisions.md sections
  // 4 and 8): plain HTTP always shows this explicit, persistent text line
  // too, for exactly as long as the server's origin remains insecure.
  const insecureLine = isInsecureOrigin(server.origin)
    ? el('p', {
        attrs: { class: 'server-row__insecure-notice' },
        children: [
          el('sp-status-light', { attrs: { variant: 'negative', size: 's' } }),
          document.createTextNode(' Insecure connection: plain HTTP, not HTTPS.'),
        ],
      })
    : undefined;

  const rowStatus = el('p', { attrs: { class: 'server-row__edit-status' } });

  const labelField = el('sp-textfield', { attrs: { 'aria-label': 'Server label' } }) as TextField;
  labelField.value = server.label;
  const originField = el('sp-textfield', {
    attrs: { 'aria-label': 'Server address' },
  }) as TextField;
  originField.value = server.origin;
  const colorPicker = createColorPicker(server.color, () => refreshDirtyState());

  const saveButton = el('sp-button', { attrs: { variant: 'accent', disabled: '' }, text: 'Save' });
  const removeButton = el('sp-button', { attrs: { variant: 'negative' }, text: 'Remove' });

  /** The exact origin the user has been warned about and must confirm with a second Save click. */
  let pendingOrigin: string | undefined;
  /** Whether Remove has already been clicked once and the deletion warning shown. */
  let removeArmed = false;
  let busy = false;

  function isDirty(): boolean {
    return (
      labelField.value !== server.label ||
      colorKey(colorPicker.read()) !== colorKey(server.color) ||
      originField.value.trim() !== server.origin
    );
  }

  function applySaveEnabled(): void {
    if (busy || !isDirty()) saveButton.setAttribute('disabled', '');
    else saveButton.removeAttribute('disabled');
  }

  function refreshDirtyState(): void {
    if (pendingOrigin !== undefined || removeArmed) {
      pendingOrigin = undefined;
      removeArmed = false;
      rowStatus.textContent = '';
    }
    applySaveEnabled();
  }

  function setBusy(value: boolean): void {
    busy = value;
    if (value) removeButton.setAttribute('disabled', '');
    else removeButton.removeAttribute('disabled');
    applySaveEnabled();
  }

  for (const field of [labelField, originField]) {
    field.addEventListener('input', refreshDirtyState);
    field.addEventListener('change', refreshDirtyState);
  }

  saveButton.addEventListener('click', () => {
    if (busy || !isDirty()) return;

    const presentation = validateEditServerForm({
      label: labelField.value,
      color: colorPicker.read(),
    });
    if (!presentation.ok) {
      pendingOrigin = undefined;
      rowStatus.textContent = Object.values(presentation.errors).filter(Boolean).join(' | ');
      return;
    }

    let originChange: string | undefined;
    if (originField.value.trim() !== server.origin) {
      const validated = validateOriginInput(originField.value);
      if (!validated.ok) {
        pendingOrigin = undefined;
        rowStatus.textContent = validated.error;
        return;
      }
      if (validated.origin !== server.origin) originChange = validated.origin;
    }

    const presentationChanged =
      presentation.value.label !== server.label ||
      colorKey(presentation.value.color) !== colorKey(server.color);

    // Only the raw text differed (spacing, a trailing slash, letter case):
    // the normalized origin is the one already saved, so there is nothing to send.
    if (!presentationChanged && originChange === undefined) {
      rowStatus.textContent = "Nothing to save: these are already this server's saved values.";
      return;
    }

    // First click on an address change: warn and arm, send nothing.
    if (originChange !== undefined && pendingOrigin !== originChange) {
      pendingOrigin = originChange;
      rowStatus.textContent =
        `Changing this server's address to ${originChange} keeps its chats, but their existing ` +
        'results stay recorded against the old address, and its certificate exception is not ' +
        'carried over. Click Save again to confirm.';
      return;
    }

    rowStatus.textContent = '';
    setBusy(true);
    void (async () => {
      if (presentationChanged) {
        const result = await window.daisy.settings.updateServerPresentation({
          serverId: server.id,
          changes: { label: presentation.value.label, color: presentation.value.color },
        });
        if (!result.ok) {
          rowStatus.textContent = result.error.message;
          return;
        }
      }
      if (originChange !== undefined) {
        const result = await window.daisy.settings.updateServerTargeting({
          serverId: server.id,
          changes: { origin: originChange },
          originChangeConfirmed: true,
        });
        if (!result.ok) {
          rowStatus.textContent = result.error.message;
          return;
        }
      }
      pendingOrigin = undefined;
      onSettingsChanged();
    })()
      .catch((error: unknown) => {
        rowStatus.textContent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => setBusy(false));
  });

  removeButton.addEventListener('click', () => {
    if (busy) return;

    // First click only warns: deleting a server requires separate
    // confirmation (requirements-decisions.md section 7).
    if (!removeArmed) {
      removeArmed = true;
      pendingOrigin = undefined;
      rowStatus.textContent =
        `Removing "${server.label}" also deletes its chats, its stored settings, its proxy ` +
        'password and its certificate exception. Click Remove again to confirm.';
      return;
    }

    removeArmed = false;
    rowStatus.textContent = '';
    setBusy(true);
    void window.daisy.settings
      .removeServer({ serverId: server.id })
      .then((result) => {
        if (!result.ok) {
          rowStatus.textContent = result.error.message;
          return;
        }
        // Removing the currently-active server is handled on the main side
        // (`settingsStore.ts`'s `removeServer`): it clears `activeServerId`
        // rather than leaving a dangling reference to a server that no
        // longer exists. This section only needs to re-fetch and re-render
        // the snapshot, which already reflects that cleared state.
        onSettingsChanged();
      })
      .finally(() => setBusy(false));
  });

  const children: HTMLElement[] = [
    heading,
    el('div', {
      attrs: { class: 'server-row__fields' },
      children: [labelField, colorPicker.element, originField],
    }),
    proxyLine,
  ];
  if (insecureLine) children.push(insecureLine);
  if (server.proxy) {
    const passwordEntry = createPasswordEntry({ kind: 'server', serverId: server.id });
    passwordEntry.onChanged(onSettingsChanged);
    children.push(passwordEntry.element);
  }
  children.push(
    el('div', { attrs: { class: 'server-row__actions' }, children: [saveButton, removeButton] }),
  );
  children.push(rowStatus);

  return el('li', { attrs: { class: 'server-row' }, children });
}

export interface ServersSection {
  readonly element: HTMLElement;
  update(servers: readonly ServerSnapshot[]): void;
}

/**
 * The servers section (requirements-decisions.md sections 3, 4, 8): the
 * configured server list plus an add-server form. `onSettingsChanged` is
 * called after any successful mutation (add, edit, remove, or a password
 * change) so the caller (`settingsPanel.ts`) can re-fetch and re-render the
 * whole snapshot - the same pattern as
 * `passwordEntry.ts` already use.
 *
 * Configuring a server's AEM proxy (address/username) is deliberately not
 * part of the row or the add form here: `settings:add-server` never accepted proxy
 * fields (a fresh server is created presentation-only; see
 * `addServerRequestSchema`'s own doc comment), and this step does not add an
 * edit UI for `updateServerTargeting`'s `proxy` field either, because that
 * field's `credentials.secretRef` is minted by main and never handed to the
 * renderer - there is nothing a form here could safely fill in for it. The
 * add-server form still accepts an optional proxy address/username (kept
 * from before this step) purely as client-side-validated input; on a
 * successful add it reports plainly that those two fields were not saved,
 * rather than silently discarding what the user typed.
 */
export function createServersSection(onSettingsChanged: () => void): ServersSection {
  const list = el('ul', { attrs: { class: 'server-list' } });

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
  const insecureCheckbox = el('sp-checkbox', {
    text: 'Allow plain HTTP (insecure) - required only for a non-HTTPS address',
  }) as CheckboxElement;
  const formErrors = el('p', { attrs: { class: 'form-errors' } });
  const formNotice = el('p', { attrs: { class: 'add-server-form__notice' } });
  const addButton = el('sp-button', { attrs: { variant: 'accent' }, text: 'Add server' });

  addButton.addEventListener('click', () => {
    const result = validateNewServerForm({
      label: labelField.value,
      origin: originField.value,
      color: colorPicker.read(),
      proxyOrigin: proxyOriginField.value,
      proxyUsername: proxyUsernameField.value,
      allowInsecureHttp: insecureCheckbox.checked,
    });
    if (!result.ok) {
      formErrors.textContent = Object.values(result.errors).filter(Boolean).join(' | ');
      formNotice.textContent = '';
      return;
    }
    formErrors.textContent = '';
    formNotice.textContent = '';
    addButton.setAttribute('disabled', '');
    void window.daisy.settings
      .addServer({
        label: result.value.label,
        origin: result.value.origin,
        color: result.value.color,
        allowInsecureHttp: result.value.allowInsecureHttp ?? false,
      })
      .then((addResult) => {
        if (!addResult.ok) {
          formErrors.textContent = addResult.error.message;
          return;
        }
        labelField.value = '';
        originField.value = '';
        proxyOriginField.value = '';
        proxyUsernameField.value = '';
        insecureCheckbox.checked = false;
        colorPicker.setValue({ kind: 'swatch', swatch: SERVER_SWATCHES[0] });
        if (result.value.proxy) {
          formNotice.textContent =
            `Server "${addResult.server.label}" was added, but its AEM proxy address/username ` +
            "were not saved - editing a server's AEM proxy is not implemented yet.";
        }
        onSettingsChanged();
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
      insecureCheckbox,
      addButton,
      formErrors,
      formNotice,
    ],
  });

  const element = el('section', {
    attrs: { class: 'settings-section', 'aria-label': 'Servers' },
    children: [list, el('h2', { text: 'Add a server' }), form],
  });

  return {
    element,
    update(servers: readonly ServerSnapshot[]): void {
      list.replaceChildren(...servers.map((server) => buildServerRow(server, onSettingsChanged)));
    },
  };
}
