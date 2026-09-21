import { el } from '../lib/dom';
import type { ProxyId, ProxySnapshot } from '../../../shared';
import { syncPickerOptions, type PickerLike } from './pickerOptions';

/** Picker sentinel for "(Default)" - inherit the browser default proxy. Only offered where `includeDefault` is set (the Hosts tab). */
export const PROXY_DEFAULT_VALUE = '__default__';
/** Picker sentinel for "(No proxy)" - an explicit direct connection. */
export const PROXY_NONE_VALUE = '__none__';

/**
 * What a proxy picker currently shows. A discriminated union rather than a
 * bare id-or-`undefined` because a host now has *three* states - "(Default)"
 * (inherit `browser.proxy`), "No proxy" (explicit direct), and a specific
 * library entry - and the two non-entry states must stay distinguishable.
 */
export type ProxySelection =
  | { readonly kind: 'default' }
  | { readonly kind: 'none' }
  | { readonly kind: 'proxy'; readonly proxyId: ProxyId };

export interface ProxyPickerHandle {
  readonly element: HTMLElement;
  /** The current selection. */
  read(): ProxySelection;
  /** Rebuilds the options from the current proxy library, keeping/repairing the selection. */
  setOptions(proxies: readonly ProxySnapshot[]): void;
  /** Sets the selection from stored state, repairing a dangling id. */
  select(selection: ProxySelection): void;
}

export interface CreateProxyPickerOptions {
  /** Id for the picker, so an external `<sp-field-label for="...">` can label it. */
  readonly fieldId: string;
  /** The stored selection; a dangling id is repaired (to Default, or No proxy when Default is not offered). */
  readonly initial: ProxySelection;
  readonly proxies: readonly ProxySnapshot[];
  /**
   * Whether the "(Default)" option is offered. True for a host (which may
   * inherit `browser.proxy`); false for the browser default proxy itself and
   * for an agent, where "no proxy" is simply the absence of a selection.
   */
  readonly includeDefault: boolean;
  readonly onChange: () => void;
}

function valueFromSelection(selection: ProxySelection): string {
  if (selection.kind === 'default') return PROXY_DEFAULT_VALUE;
  if (selection.kind === 'none') return PROXY_NONE_VALUE;
  return selection.proxyId;
}

function selectionFromValue(value: string): ProxySelection {
  if (value === PROXY_DEFAULT_VALUE) return { kind: 'default' };
  if (value === PROXY_NONE_VALUE) return { kind: 'none' };
  return { kind: 'proxy', proxyId: value as ProxyId };
}

/**
 * The Proxy combobox: an `sp-picker` whose items are the special choices plus
 * one per entry of the settings "Proxies" library. It *displays* each entry's
 * label but *stores and returns* its id - the caller never persists a label.
 *
 * The options are re-derived from the live library on every
 * {@link ProxyPickerHandle.setOptions}, so an add/rename/remove on the Proxies
 * tab is reflected here. A selection whose entry no longer exists is repaired
 * rather than left pointing at a missing id (main also clears the dangling
 * reference in the same write; see `removeProxy`): to "(Default)" where that is
 * offered, else to "(No proxy)".
 */
export function createProxyPicker(options: CreateProxyPickerOptions): ProxyPickerHandle {
  const picker = el('sp-picker', {
    attrs: {
      id: options.fieldId,
      class: 'host-field__input proxy-picker',
      'aria-label': 'Proxy',
    },
  }) as PickerLike;

  let proxies = options.proxies;
  let selected: ProxySelection = options.initial;

  function reconcile(selection: ProxySelection): ProxySelection {
    if (selection.kind === 'default' && !options.includeDefault) return { kind: 'none' };
    if (selection.kind === 'proxy' && !proxies.some((proxy) => proxy.id === selection.proxyId)) {
      return options.includeDefault ? { kind: 'default' } : { kind: 'none' };
    }
    return selection;
  }

  function render(): void {
    syncPickerOptions(
      picker,
      [
        ...(options.includeDefault ? [{ value: PROXY_DEFAULT_VALUE, label: '(Default)' }] : []),
        { value: PROXY_NONE_VALUE, label: '(No proxy)' },
        ...proxies.map((proxy) => ({ value: proxy.id, label: proxy.label })),
      ],
      valueFromSelection(selected),
    );
  }

  selected = reconcile(selected);
  render();

  picker.addEventListener('change', () => {
    selected = selectionFromValue(picker.value);
    options.onChange();
  });

  return {
    element: picker,
    read(): ProxySelection {
      return selected;
    },
    setOptions(next): void {
      proxies = next;
      selected = reconcile(selected);
      render();
    },
    select(selection): void {
      selected = reconcile(selection);
      render();
    },
  };
}
