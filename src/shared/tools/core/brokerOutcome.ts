import type { BrokerOutcome } from './types';

/**
 * The tool-agnostic classification of a bridge failure, before any HTTP or JSON
 * interpretation.
 *
 * Each tool owns its own error wording, but the *identity* of a broker failure
 * is the same vocabulary for every tool: a redirect is a redirect, a timeout is
 * a timeout. Extracting the mapping here keeps that vocabulary in one place
 * instead of duplicated verbatim in each tool module.
 */
export type BrokerErrorKey =
  | 'redirect_blocked'
  | 'cross_origin'
  | 'network_error'
  | 'cancelled'
  | 'timeout'
  | 'stale_server_revision'
  | 'stale_navigation_epoch'
  | 'no_view';

/** A broker outcome that is not a response - i.e. one that names a failure. */
export type NonResponseBrokerOutcome = Exclude<BrokerOutcome, { kind: 'response' }>;

/**
 * Maps a non-response {@link BrokerOutcome} to one named failure. `invalid_url`
 * (a `blocked` reason this application cannot reach from a URL it built and
 * round-tripped through `URL` itself) is folded into `cross_origin`: both mean
 * the bridge declined to issue the request as addressed.
 */
export function brokerErrorKey(outcome: NonResponseBrokerOutcome): BrokerErrorKey {
  switch (outcome.kind) {
    case 'blocked':
      return outcome.reason === 'redirect_blocked' ? 'redirect_blocked' : 'cross_origin';
    case 'network_error':
      return 'network_error';
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
      return 'timeout';
    case 'stale':
      return outcome.status;
    case 'no_view':
      return 'no_view';
  }
}
