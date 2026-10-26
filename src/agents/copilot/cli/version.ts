/**
 * Version strings for the Copilot CLI an external, self-updating tool exposes.
 *
 * We never decide a version ourselves: a candidate is whatever binary answers
 * `--version`, and the number is read back from that answer. This module is
 * pure so the parsing and the "is it new enough" rule are unit tested without
 * spawning anything.
 */

/** `1.0.103` - the only shape the CLI prints (`GitHub Copilot CLI 1.0.103.`). */
const VERSION_IN_TEXT = /\b(\d+)\.(\d+)\.(\d+)\b/;

/**
 * Reads the version out of `copilot --version` output. Tolerates the trailing
 * period, surrounding prose, and a line printed on stdout or stderr. Returns
 * `undefined` for anything that is not a three-part version, so an unrelated
 * executable on PATH can never be mistaken for the CLI.
 */
export function parseCliVersion(text: string): string | undefined {
  const match = VERSION_IN_TEXT.exec(text);
  if (match === null) return undefined;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Numeric comparison of two `x.y.z` strings; `a - b` semantics. */
export function compareCliVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether a candidate may be used. The floor is the oldest CLI this build was
 * verified against - an older one may predate `login --web-flow` altogether.
 * Deliberately a *minimum*, not a pin: the CLI updates itself regardless, and
 * pretending otherwise was what the old add-on did.
 */
export function isSupportedCliVersion(version: string, floor: string): boolean {
  return compareCliVersions(version, floor) >= 0;
}
