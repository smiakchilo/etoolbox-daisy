import { el } from '../lib/dom';

/**
 * Shared option/selection sync for the Settings panel's `sp-picker`s.
 *
 * An `sp-picker` is a custom element whose shadow DOM (the button that shows
 * the selected label) is rendered a frame after it is inserted. Tearing one
 * down and re-creating it therefore leaves a one-frame blank at its place -
 * visible as a flicker in every picker on screen whenever the surrounding
 * section was rebuilt from a fresh snapshot. Rebuilding the section on each
 * settings re-read is avoidable; the picker itself is the thing that must not
 * be re-created.
 *
 * This helper updates the existing picker in place: the option children are
 * only replaced when a value/label genuinely changed (replacing identical
 * `sp-menu-item`s also makes the picker re-render its selected label), and the
 * value is only assigned when it differs.
 */

/** One option in a picker: the stored value and the label shown for it. */
export interface PickerOption {
  readonly value: string;
  readonly label: string;
}

/** The sliver of `sp-picker`'s surface this helper touches. */
export type PickerLike = HTMLElement & { value: string };

export function syncPickerOptions(
  picker: PickerLike,
  options: readonly PickerOption[],
  selected: string,
): void {
  const unchanged =
    picker.children.length === options.length &&
    options.every((option, index) => {
      const node = picker.children[index];
      return (
        node !== undefined &&
        node.getAttribute('value') === option.value &&
        node.textContent === option.label
      );
    });
  if (!unchanged) {
    picker.replaceChildren(
      ...options.map((option) =>
        el('sp-menu-item', { attrs: { value: option.value }, text: option.label }),
      ),
    );
  }
  if (picker.value !== selected) picker.value = selected;
}
