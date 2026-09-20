/**
 * Merges a Chromium feature name into an existing `--disable-features` switch
 * value.
 *
 * Chromium's `--disable-features` is a single comma-separated value, and the
 * build already ships a non-empty default list. Appending a second
 * `--disable-features` switch is not reliably merged (the earlier value can
 * win), so the existing list is read back, de-duplicated and extended here
 * instead. Pure and dependency-free so the merge rule has a direct unit test.
 */
export function mergeDisabledFeatures(existing: string, feature: string): string {
  const features = existing
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!features.includes(feature)) {
    features.push(feature);
  }
  return features.join(',');
}
