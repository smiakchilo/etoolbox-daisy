/** CSS selector for an element carrying the stable `data-testid` hook. */
export function byTestId(id: string): string {
  return `[data-testid="${id}"]`;
}

/** CSS selector for a Settings form field carrying the stable `data-field` hook. */
export function byField(id: string): string {
  return `[data-field="${id}"]`;
}
