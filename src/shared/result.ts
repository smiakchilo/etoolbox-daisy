/**
 * Small typed result helper used at IPC and other trust boundaries instead of
 * throwing across process boundaries. Consumers must narrow on `ok` before
 * reading `value`/`error`.
 */
export type Result<TValue, TError = string> =
  { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly error: TError };

export function ok<TValue>(value: TValue): Result<TValue, never> {
  return { ok: true, value };
}

export function err<TError>(error: TError): Result<never, TError> {
  return { ok: false, error };
}

export function isOk<TValue, TError>(
  result: Result<TValue, TError>,
): result is { readonly ok: true; readonly value: TValue } {
  return result.ok;
}

export function unwrap<TValue, TError>(result: Result<TValue, TError>): TValue {
  if (!result.ok) {
    throw new Error(`unwrap() called on an error result: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}
