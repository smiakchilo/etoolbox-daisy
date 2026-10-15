import { el } from '../lib/dom';

/**
 * Contextual help for the Settings panel's fields: a short phrase (the field's
 * role, then its limitations) shown from a small `sp-contextual-help` badge
 * immediately after the field's label.
 *
 * The text is fixed in code - there is no translation layer and none is planned.
 * Every field the Settings panel renders carries one; see `AGENTS.md` section 5,
 * "Contextual help on every Settings field". The per-section unit tests assert
 * the exact badge set, so a new field without its help fails them.
 */

/** Drops a trailing `(required)` so the badge's accessible name reads just the field name. */
function stripRequired(label: string): string {
  return label.replace(/ \(required\)$/, '');
}

/** Builds the `<sp-contextual-help>` badge for one field. */
export function createContextualHelp(text: string, accessibleName: string): HTMLElement {
  return el('sp-contextual-help', {
    attrs: {
      class: 'field-help',
      label: accessibleName,
      // The badge sits just after the label, near the left of a wide panel, so
      // the popover opens rightward (start-aligned) to stay inside the panel.
      placement: 'bottom-start',
    },
    text,
  });
}

/** The accessible-name a field's badge derives from its visible label. */
export function helpAccessibleName(label: string): string {
  return `Help: ${stripRequired(label)}`;
}

/**
 * One labelled Settings field: a label row (the visible label, then an optional
 * contextual-help badge immediately after it) above the control.
 *
 * This is the one field block every section builds. A new field is a call here
 * with its help text, never a hand-written `<sp-field-label>` + control pair.
 */
export function labelledField(
  fieldId: string,
  label: string,
  control: HTMLElement,
  helpText?: string,
): HTMLElement {
  const labelRow = el('div', {
    attrs: { class: 'field-label-row' },
    children: [
      el('sp-field-label', { attrs: { for: fieldId }, text: label }),
      ...(helpText === undefined
        ? []
        : [createContextualHelp(helpText, helpAccessibleName(label))]),
    ],
  });
  return el('div', { attrs: { class: 'host-field' }, children: [labelRow, control] });
}
