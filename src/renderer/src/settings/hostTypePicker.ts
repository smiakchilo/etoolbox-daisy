import { el } from '../lib/dom';
import { HOST_TYPES, type HostType } from '../../../shared';
import { syncPickerOptions, type PickerLike } from './pickerOptions';

/** Picker sentinel for "(Default)" - no role recorded, so the host belongs to no pair. */
export const HOST_TYPE_DEFAULT_VALUE = '__default__';

/** The label shown for each stored role, in the order the menu offers them. */
const HOST_TYPE_LABELS: Readonly<Record<HostType, string>> = {
  author: 'Author',
  publish: 'Publish',
};

export interface HostTypePickerHandle {
  readonly element: HTMLElement;
  /** The chosen role, or `undefined` for "(Default)". */
  read(): HostType | undefined;
  /** Sets the selection from stored state. */
  select(type: HostType | undefined): void;
}

export interface CreateHostTypePickerOptions {
  /** Id for the picker, so an external `<sp-field-label for="...">` can label it. */
  readonly fieldId: string;
  /** The stored role; `undefined` is "(Default)". */
  readonly initial: HostType | undefined;
  readonly onChange: () => void;
}

function valueFromType(type: HostType | undefined): string {
  return type ?? HOST_TYPE_DEFAULT_VALUE;
}

function typeFromValue(value: string): HostType | undefined {
  return HOST_TYPES.find((type) => type === value);
}

/**
 * The Type combobox: an `sp-picker` whose options are the fixed host roles
 * ({@link HOST_TYPES} - Author, Publish) plus "(Default)".
 *
 * "(Default)" is a picker sentinel, not the value the model stores: the
 * contract carries *no* `type` key at all for it (`undefined`), the same way
 * `proxyId`/`projectId` spell their "(Default)" choice. An `sp-menu-item` also
 * cannot carry an empty value - its value getter falls back to its own text -
 * so a sentinel is the only way to offer it (the Proxy and Project pickers do
 * the same). {@link HostTypePickerHandle.read} therefore hands the caller
 * `undefined` for "(Default)", and `null` reaches the contract from there.
 */
export function createHostTypePicker(options: CreateHostTypePickerOptions): HostTypePickerHandle {
  const picker = el('sp-picker', {
    attrs: {
      id: options.fieldId,
      class: 'host-field__input host-type-picker',
      'aria-label': 'Type',
    },
  }) as PickerLike;

  let selected: HostType | undefined = options.initial;

  function render(): void {
    syncPickerOptions(
      picker,
      [
        { value: HOST_TYPE_DEFAULT_VALUE, label: '(Default)' },
        ...HOST_TYPES.map((type) => ({ value: type, label: HOST_TYPE_LABELS[type] })),
      ],
      valueFromType(selected),
    );
  }

  render();

  picker.addEventListener('change', () => {
    selected = typeFromValue(picker.value);
    options.onChange();
  });

  return {
    element: picker,
    read(): HostType | undefined {
      return selected;
    },
    select(type): void {
      selected = type;
      render();
    },
  };
}
