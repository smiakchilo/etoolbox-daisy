import {
  parseOrigin,
  serverColorSchema,
  serverLabelSchema,
  type OriginRejectionReason,
  type ServerColor,
} from '../../../shared';

/** Human-readable reason a candidate origin was rejected, for inline form errors. */
const ORIGIN_REJECTION_MESSAGES: Readonly<Record<OriginRejectionReason, string>> = {
  malformed: 'must be a valid address, e.g. https://author.example',
  unsupported_scheme: 'must start with http:// or https://',
  contains_userinfo: 'must not include a username or password',
  contains_path: 'must be scheme://host[:port] only, with no page path',
  contains_query: 'must not include a query string',
  contains_fragment: 'must not include a #fragment',
  missing_host: 'must include a host',
};

/**
 * Validates a raw origin string typed into a host item's address field,
 * reusing the same shared `parseOrigin` (and the same rejection messages) the
 * main process enforces again when it persists the entry. This only gives the
 * user immediate feedback; it is never a substitute for main's own validation,
 * which re-checks everything independently.
 */
export function validateOriginInput(
  value: string,
): { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly error: string } {
  const result = parseOrigin(value);
  if (!result.ok) {
    return { ok: false, error: ORIGIN_REJECTION_MESSAGES[result.reason] };
  }
  return { ok: true, origin: result.origin };
}

/**
 * An optional label is allowed to be blank, in which case it defaults to the
 * host's address (the one required field). Everything else is validated by the
 * exact `serverLabelSchema` main will re-apply, so an over-long label or one
 * with surrounding whitespace is reported inline rather than at save time.
 *
 * The blank-label case returns `{ ok: true, label: "" }` when the address is
 * itself blank: there is no address to default to yet, and the address field
 * already reports that. The caller only persists once the address is valid, at
 * which point the default resolves to the address.
 */
export function resolveHostLabelInput(
  rawLabel: string,
  origin: string,
): { readonly ok: true; readonly label: string } | { readonly ok: false; readonly error: string } {
  const trimmed = rawLabel.trim();
  const candidate = trimmed === '' ? origin : trimmed;
  if (candidate === '') {
    return { ok: true, label: '' };
  }
  const result = serverLabelSchema.safeParse(candidate);
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'invalid label' };
  }
  return { ok: true, label: result.data };
}

/**
 * Validates a project item's required label, reusing the same
 * `serverLabelSchema` main re-applies. Unlike a host label there is no address
 * to default a blank label to: a project is only ever identified by its label,
 * so a blank one is an error rather than a fallback.
 */
export function validateProjectLabelInput(
  rawLabel: string,
): { readonly ok: true; readonly label: string } | { readonly ok: false; readonly error: string } {
  const result = serverLabelSchema.safeParse(rawLabel.trim());
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'invalid label' };
  }
  return { ok: true, label: result.data };
}

/** The raw shape a colour picker reads back, before validation. */
export type RawServerColor =
  | { readonly kind: 'swatch'; readonly swatch: string }
  | { readonly kind: 'custom'; readonly hex: string };

/** Validates a colour picker's read value with the shared `serverColorSchema`. */
export function validateHostColorInput(
  color: RawServerColor,
):
  | { readonly ok: true; readonly value: ServerColor }
  | { readonly ok: false; readonly error: string } {
  const result = serverColorSchema.safeParse(color);
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'invalid colour' };
  }
  return { ok: true, value: result.data };
}
