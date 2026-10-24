/**
 * The Spectrum status-light variant a `status` table cell wears, chosen from the
 * cell's own text. The text always stays in the cell (so Copy and Export carry
 * it); the colour is only a reinforcement, and an unrecognised word is neutral.
 */
export type StatusLightVariant = 'positive' | 'notice' | 'negative' | 'info' | 'neutral';

const POSITIVE = new Set(['pass', 'passed', 'ok', 'good', 'success', 'succeeded', 'yes', 'valid']);
const NOTICE = new Set(['warn', 'warning', 'average', 'partial', 'needs improvement', 'slow']);
const NEGATIVE = new Set([
  'fail',
  'failed',
  'error',
  'bad',
  'poor',
  'broken',
  'critical',
  'no',
  'invalid',
]);
const INFO = new Set(['info', 'information', 'notice', 'manual']);

export function statusLightVariant(value: string): StatusLightVariant {
  const word = value.trim().toLowerCase();
  if (POSITIVE.has(word)) return 'positive';
  if (NOTICE.has(word)) return 'notice';
  if (NEGATIVE.has(word)) return 'negative';
  if (INFO.has(word)) return 'info';
  return 'neutral';
}
