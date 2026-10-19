import type { Locator } from '@playwright/test';

/**
 * The vertical gap, in whole CSS pixels, between two stacked boxes: the lower
 * box's top edge minus the upper box's bottom edge.
 *
 * The Settings specs use it to assert a **relational** spacing fact - a widened
 * subsection boundary is larger than the plain field gap inside a subsection -
 * rather than pinning either gap's exact value, which would certify a
 * production-owned CSS literal (AGENTS.md section 9, rule 1).
 */
export async function verticalGap(above: Locator, below: Locator): Promise<number> {
  const [upper, lower] = await Promise.all([above.boundingBox(), below.boundingBox()]);
  if (upper === null || lower === null) {
    throw new Error('cannot measure a gap: a locator has no bounding box');
  }
  return Math.round(lower.y - (upper.y + upper.height));
}
