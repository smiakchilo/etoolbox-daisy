/**
 * Tiny `document.createElement` helper. This codebase builds the DOM
 * imperatively rather than with a template library; this helper only
 * removes the repetitive create-element/set-attributes/set-text boilerplate
 * that pattern otherwise repeats at every call site.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: {
    readonly attrs?: Readonly<Record<string, string>>;
    readonly text?: string;
    readonly children?: readonly Node[];
  },
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options?.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      node.setAttribute(name, value);
    }
  }
  if (options?.text !== undefined) {
    node.textContent = options.text;
  }
  if (options?.children) {
    node.append(...options.children);
  }
  return node;
}
