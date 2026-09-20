import { el } from '../lib/dom';
import type { ProxyId, ProxySnapshot } from '../../../shared';
import { syncPickerOptions, type PickerLike } from './pickerOptions';

/** Sentinel id for the "(No proxy)" choice; real ids are generated uuids. */
export const NO_PROXY_VALUE = '__no_proxy__';

export interface ProxyPickerHandle {
  readonly element: HTMLElement;
  /** The selected library id, or `undefined` for "(No proxy)". */
  read(): ProxyId | undefined;
  /** Rebuilds the options from the current proxy library, keeping/repairing the selection. */
  setOptions(proxies: readonly ProxySnapshot[]): void;
  /** Sets the selection from stored state, repairing a dangling id to "(No proxy)". */
  select(id: ProxyId | undefined): void;
}

export interface CreateProxyPickerOptions {
  /** Id for the picker, so an external `<sp-field-label for="...">` can label it. */
  readonly fieldId: string;
  /** The host's stored library id, if any; a missing one falls back to "(No proxy)". */
  readonly initialProxyId: ProxyId | undefined;
  readonly proxies: readonly ProxySnapshot[];
  readonly onChange: () => void;
}

/**
 * The host's "Proxy" combobox: an `sp-picker` whose items are "(No proxy)" plus
 * one per entry of the settings "Proxies" library. It *displays* each entry's
 * label but *stores and returns* its id - the caller never persists a label.
 *
 * The options are re-derived from the live library on every
 * {@link ProxyPickerHandle.setOptions}, so an add/rename/remove on the Proxies
 * tab is reflected here. A selection whose entry no longer exists is repaired
 * to "(No proxy)" rather than left pointing at a missing id (main clears the
 * dangling reference in the same write; see `removeProxy`).
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
  let selected: string = options.initialProxyId ?? NO_PROXY_VALUE;

  function reconcile(id: string): string {
    if (id === NO_PROXY_VALUE) return NO_PROXY_VALUE;
    return proxies.some((proxy) => proxy.id === id) ? id : NO_PROXY_VALUE;
  }

  function render(): void {
    syncPickerOptions(
      picker,
      [
        { value: NO_PROXY_VALUE, label: '(No proxy)' },
        ...proxies.map((proxy) => ({ value: proxy.id, label: proxy.label })),
      ],
      selected,
    );
  }

  selected = reconcile(selected);
  render();

  picker.addEventListener('change', () => {
    selected = picker.value;
    options.onChange();
  });

  return {
    element: picker,
    read(): ProxyId | undefined {
      return selected === NO_PROXY_VALUE ? undefined : (selected as ProxyId);
    },
    setOptions(next): void {
      proxies = next;
      selected = reconcile(selected);
      render();
    },
    select(id): void {
      selected = reconcile(id ?? NO_PROXY_VALUE);
      render();
    },
  };
}
