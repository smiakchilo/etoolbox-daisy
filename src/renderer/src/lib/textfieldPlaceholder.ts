/**
 * Global placeholder colour for every `sp-textfield`/`sp-textarea`.
 *
 * Spectrum's textfield styles the placeholder with the *same* custom property
 * it uses for the value's text colour
 * (`--mod-textfield-text-color-default`), so there is no placeholder-specific
 * token to override: setting that token would also recolour the value. The
 * placeholder rule lives inside the component's shadow root, which document
 * CSS cannot reach.
 *
 * The one surgical way to change only the placeholder is therefore to add a
 * rule to each field's shadow root. This module does exactly that - once, for
 * the whole app - and keeps doing it for fields created later (the Settings
 * panel builds and rebuilds many of them). The colour reads
 * `--daisy-textfield-placeholder-color` (defined on `sp-theme`, see
 * `styles/base.css`) so it stays theme-configurable, and falls back to 50%
 * gray.
 *
 * `!important` is deliberate: it must also win over the component's
 * focus/hover/disabled placeholder rules, or the placeholder would flash back
 * to the value colour on interaction.
 */
const STYLE_ATTRIBUTE = 'data-daisy-placeholder';

const PLACEHOLDER_CSS = `
.input::placeholder,
textarea::placeholder {
  color: var(--daisy-textfield-placeholder-color, #808080) !important;
  opacity: 1;
}
`;

function applyTo(field: Element): void {
  const root = (field as HTMLElement).shadowRoot;
  if (root === null) return;
  if (root.querySelector(`style[${STYLE_ATTRIBUTE}]`) !== null) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTRIBUTE, '');
  style.textContent = PLACEHOLDER_CSS;
  root.append(style);
}

function applyToTree(node: Node): void {
  // 1 === Node.ELEMENT_NODE; the literal avoids depending on a global `Node`
  // in the jsdom unit-test setup.
  if (node.nodeType !== 1) return;
  const element = node as Element;
  if (element.matches('sp-textfield')) applyTo(element);
  for (const field of element.querySelectorAll('sp-textfield')) applyTo(field);
}

/**
 * Installs the placeholder colour for every current and future text field.
 * Returns a disposer (used by tests); production calls it once at startup and
 * never tears it down.
 */
export function installTextfieldPlaceholderColor(): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) applyToTree(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  for (const field of document.querySelectorAll('sp-textfield')) applyTo(field);
  return () => observer.disconnect();
}
