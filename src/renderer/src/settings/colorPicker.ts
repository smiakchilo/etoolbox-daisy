import { el } from '../lib/dom';
import { resolveServerColorCss, resolveServerSwatchFromHex } from '../lib/serverColor';
import { SERVER_SWATCHES, type ServerColor, type ServerSwatch } from '../../../shared';

type TextField = HTMLElement & { value: string };

const SWATCH_SET = new Set<string>(SERVER_SWATCHES);

/** Narrowing guard: is this (possibly user-typed) string one of the named swatches? */
export function isSwatch(value: string): value is ServerSwatch {
  return SWATCH_SET.has(value);
}

/** The label shown in the picker's menu: the swatch key with a capital first letter. */
function swatchLabel(swatch: string): string {
  return swatch.charAt(0).toUpperCase() + swatch.slice(1);
}

/**
 * Normalizes a colour to a comparable key, so "is the colour dirty?" ignores
 * case and surrounding whitespace. Shared with the hosts section, which uses
 * it to decide whether a row's colour actually changed.
 */
export function colorKey(
  color:
    | ServerColor
    | { readonly kind: 'swatch'; readonly swatch: string }
    | { readonly kind: 'custom'; readonly hex: string },
): string {
  return color.kind === 'custom'
    ? `custom:${color.hex.trim().toLowerCase()}`
    : `swatch:${color.swatch.trim().toLowerCase()}`;
}

export interface ColorPickerHandle {
  readonly element: HTMLElement;
  read():
    | { readonly kind: 'swatch'; readonly swatch: string }
    | { readonly kind: 'custom'; readonly hex: string };
  setValue(color: ServerColor): void;
  /** Shows (`message`) or hides the inline invalid state on the hex field. */
  setError(message: string | undefined): void;
}

export interface CreateColorPickerOptions {
  /** Id for the hex field, so an external `<sp-field-label for="...">` can label it. */
  readonly fieldId: string;
  readonly initial: ServerColor;
  /**
   * Fired on every `input` in the hex field, for immediate inline feedback
   * (the caller validates and may show `setError`). It must NOT persist: a
   * typed value is only committed when the field is left.
   */
  readonly onInput?: () => void;
  /**
   * Fired when the value is deliberately committed: leaving the field
   * (`change`, i.e. blur or Enter) or picking a swatch from the menu. This is
   * the caller's save trigger.
   */
  readonly onCommit?: () => void;
}

/**
 * The colour field shared by every host item: a plain, always-typable
 * `sp-textfield` holding a `#rrggbb` hex string (typed freely, or a named
 * swatch's concrete value written by a pick) plus an `sp-action-menu` "picker
 * button" beside it listing the named swatches with their colour dots.
 * Selecting an item writes that swatch's hex into the field - the exact same
 * textfield-plus-picker-button pattern as the browser toolbar's address
 * bar/hosts picker (`browserToolbar.ts`), chosen for the same reason: it keeps
 * the field itself as the single source of truth and typable at all times,
 * with the menu as a pure convenience for the common case. The field accepts a
 * bare swatch name like `blue` as shorthand, and on read a value matching a
 * named swatch's hex round-trips back to the swatch.
 *
 * The visible "Color tag" label is *not* rendered here: the field's own
 * `label` property is only an `aria-label` (Spectrum renders no visible
 * label), so the caller places an `<sp-field-label for=fieldId>` above the
 * returned `.color-picker` - the same label-on-top pattern the other host
 * fields use.
 */
export function createColorPicker(options: CreateColorPickerOptions): ColorPickerHandle {
  const colorField = el('sp-textfield', {
    attrs: {
      id: options.fieldId,
      class: 'color-picker__field',
      placeholder: '#2680eb or a swatch name',
      'aria-label': 'Color tag',
    },
  }) as TextField;
  const negativeHelp = el('span', { attrs: { slot: 'negative-help-text' } });
  colorField.append(negativeHelp);

  // The live preview dot: always shows the currently selected colour (typed
  // swatch name/hex or picked from the menu), so the colour is visible without
  // opening the menu. It is the same `.server-swatch` dot the browser pane
  // uses, sized up a little for a standalone field. It is positioned
  // absolutely *inside* the field's left edge by CSS (`.color-picker__preview`
  // in settings.css), over the field's extra inline padding, so the field's
  // box itself stays flush with the other host fields.
  const preview = el('span', {
    attrs: { class: 'server-swatch color-picker__preview', role: 'presentation' },
  });

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
    updatePreview();
    // A menu pick is a deliberate commit, unlike typing into the field.
    options.onCommit?.();
  });

  /**
   * The field's value as a colour, or `undefined` when it is not one yet (e.g.
   * a half-typed or invalid hex). Kept separate from {@link ColorPickerHandle.read}
   * so the preview and the save path agree on "what colour is this?".
   */
  function readColor(): ServerColor | undefined {
    const value = colorField.value.trim();
    const normalized = value.toLowerCase();
    if (isSwatch(normalized)) {
      return { kind: 'swatch', swatch: normalized };
    }
    // A picked swatch put its hex in the field; a known swatch hex must
    // round-trip back to the swatch, or an untouched pick would degrade to a
    // stored `custom` value (and flag the colour dirty on the next save).
    const swatch = resolveServerSwatchFromHex(normalized);
    if (swatch !== undefined) {
      return { kind: 'swatch', swatch };
    }
    if (/^#[0-9a-f]{6}$/i.test(value)) {
      return { kind: 'custom', hex: normalized };
    }
    return undefined;
  }

  function updatePreview(): void {
    const color = readColor();
    preview.style.backgroundColor =
      color === undefined ? 'transparent' : resolveServerColorCss(color);
  }

  colorField.addEventListener('input', updatePreview);
  colorField.addEventListener('change', updatePreview);

  if (options.onInput) colorField.addEventListener('input', options.onInput);
  if (options.onCommit) colorField.addEventListener('change', options.onCommit);

  function setValue(color: ServerColor): void {
    colorField.value =
      color.kind === 'custom'
        ? color.hex
        : resolveServerColorCss({ kind: 'swatch', swatch: color.swatch });
    updatePreview();
  }

  function setError(message: string | undefined): void {
    if (message === undefined) {
      colorField.removeAttribute('invalid');
      negativeHelp.textContent = '';
      return;
    }
    colorField.setAttribute('invalid', '');
    negativeHelp.textContent = message;
  }

  setValue(options.initial);

  // The preview dot is positioned absolutely inside the combo's field (see
  // settings.css `.color-picker__preview`), so it is a DOM sibling purely for
  // ordering; it never participates in the field+button seam geometry.
  const combo = el('div', {
    attrs: { class: 'color-picker' },
    children: [colorField, colorMenuButton],
  });
  const element = el('div', {
    attrs: { class: 'color-picker-field' },
    children: [preview, combo],
  });

  return {
    element,
    read() {
      // An invalid value is returned as a `custom` colour so the caller's
      // validator reports it inline (the preview shows no colour meanwhile).
      return readColor() ?? { kind: 'custom', hex: colorField.value.trim() };
    },
    setValue,
    setError,
  };
}
