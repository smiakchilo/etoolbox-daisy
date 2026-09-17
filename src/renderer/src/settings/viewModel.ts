import {
  isInsecureOrigin,
  parseOrigin,
  serverColorSchema,
  serverLabelSchema,
  type AemProxySnapshot,
  type CopilotProxySnapshot,
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

/** Raw values collected from the "Add server" form. Every field is a plain string, matching a textfield's `.value`. */
export interface NewServerFormInput {
  readonly label: string;
  readonly origin: string;
  readonly color:
    | { readonly kind: 'swatch'; readonly swatch: string }
    | { readonly kind: 'custom'; readonly hex: string };
  /** Empty string means "no AEM proxy configured". */
  readonly proxyOrigin: string;
  /** Empty string means "no proxy username set". Ignored unless `proxyOrigin` is set. */
  readonly proxyUsername: string;
  /**
   * Whether the user has explicitly ticked the "allow plain HTTP" checkbox.
   * Only meaningful when `origin` is insecure (requirements-decisions.md
   * section 4: plain HTTP is allowed only for explicitly configured
   * servers, never silently); ignored for an HTTPS origin.
   */
  readonly allowInsecureHttp: boolean;
}

export interface NewServerFormErrors {
  readonly label?: string;
  readonly origin?: string;
  readonly color?: string;
  readonly proxyOrigin?: string;
  readonly proxyUsername?: string;
  readonly allowInsecureHttp?: string;
}

export interface ValidatedNewServer {
  readonly label: string;
  readonly origin: string;
  readonly color: ServerColor;
  readonly proxy?: { readonly origin: string; readonly username?: string };
  /**
   * Present (and always `true`) only when `origin` is plain HTTP and the
   * user explicitly confirmed it; omitted for an HTTPS origin, where the
   * flag is meaningless. This is what `serversSection.ts` forwards as
   * `AddServerRequest.allowInsecureHttp` (defaulting to `false` when absent).
   */
  readonly allowInsecureHttp?: true;
}

export type NewServerFormResult =
  | { readonly ok: true; readonly value: ValidatedNewServer }
  | { readonly ok: false; readonly errors: NewServerFormErrors };

/**
 * Client-side validation for the "Add server" form, reusing the exact shared
 * schemas the main process will enforce again once it persists the entry
 * (`settings:add-server`, `src/main/ipc/settings.ts`) - this only gives the
 * user immediate feedback; it is never a substitute for main's own
 * validation, which re-checks everything independently.
 */
export function validateNewServerForm(input: NewServerFormInput): NewServerFormResult {
  const errors: {
    label?: string;
    origin?: string;
    color?: string;
    proxyOrigin?: string;
    proxyUsername?: string;
    allowInsecureHttp?: string;
  } = {};

  const labelResult = serverLabelSchema.safeParse(input.label);
  if (!labelResult.success) {
    errors.label = labelResult.error.issues[0]?.message ?? 'invalid label';
  }

  const originResult = parseOrigin(input.origin);
  if (!originResult.ok) {
    errors.origin = ORIGIN_REJECTION_MESSAGES[originResult.reason];
  }

  const colorResult = serverColorSchema.safeParse(input.color);
  if (!colorResult.success) {
    errors.color = colorResult.error.issues[0]?.message ?? 'invalid colour';
  }

  const proxyOrigin = input.proxyOrigin.trim();
  const proxyUsername = input.proxyUsername.trim();
  const proxyOriginResult = proxyOrigin === '' ? undefined : parseOrigin(proxyOrigin);
  if (proxyOriginResult && !proxyOriginResult.ok) {
    errors.proxyOrigin = ORIGIN_REJECTION_MESSAGES[proxyOriginResult.reason];
  } else if (proxyOrigin === '' && proxyUsername !== '') {
    errors.proxyUsername = 'a proxy username requires a proxy address';
  }

  // Plain HTTP is allowed only for explicitly configured servers
  // (requirements-decisions.md section 4) - never silently, and never
  // signalled by colour alone. This check only ever fires for an origin
  // that already parsed successfully as HTTP.
  const requiresInsecureConfirmation = originResult.ok && isInsecureOrigin(originResult.origin);
  if (requiresInsecureConfirmation && !input.allowInsecureHttp) {
    errors.allowInsecureHttp =
      'check \u201cAllow plain HTTP\u201d to confirm this insecure address is intentional';
  }

  const isValid =
    labelResult.success &&
    originResult.ok &&
    colorResult.success &&
    (proxyOriginResult === undefined || proxyOriginResult.ok) &&
    (!requiresInsecureConfirmation || input.allowInsecureHttp) &&
    Object.keys(errors).length === 0;

  if (!isValid || !labelResult.success || !originResult.ok || !colorResult.success) {
    return { ok: false, errors };
  }

  const proxy =
    proxyOriginResult && proxyOriginResult.ok
      ? {
          origin: proxyOriginResult.origin,
          ...(proxyUsername !== '' ? { username: proxyUsername } : {}),
        }
      : undefined;

  return {
    ok: true,
    value: {
      label: labelResult.data,
      origin: originResult.origin,
      color: colorResult.data,
      ...(proxy ? { proxy } : {}),
      ...(requiresInsecureConfirmation ? { allowInsecureHttp: true as const } : {}),
    },
  };
}

/** Raw values collected from a server row's inline "Edit" form (label + colour, i.e. presentation only - see `updateServerPresentationRequestSchema`). */
export interface EditServerFormInput {
  readonly label: string;
  readonly color:
    | { readonly kind: 'swatch'; readonly swatch: string }
    | { readonly kind: 'custom'; readonly hex: string };
}

export interface EditServerFormErrors {
  readonly label?: string;
  readonly color?: string;
}

export interface ValidatedEditServer {
  readonly label: string;
  readonly color: ServerColor;
}

export type EditServerFormResult =
  | { readonly ok: true; readonly value: ValidatedEditServer }
  | { readonly ok: false; readonly errors: EditServerFormErrors };

/** Client-side validation for a server row's inline label/colour edit, mirroring `settings:update-server-presentation`'s own schema. */
export function validateEditServerForm(input: EditServerFormInput): EditServerFormResult {
  const errors: { label?: string; color?: string } = {};

  const labelResult = serverLabelSchema.safeParse(input.label);
  if (!labelResult.success) {
    errors.label = labelResult.error.issues[0]?.message ?? 'invalid label';
  }

  const colorResult = serverColorSchema.safeParse(input.color);
  if (!colorResult.success) {
    errors.color = colorResult.error.issues[0]?.message ?? 'invalid colour';
  }

  if (!labelResult.success || !colorResult.success) {
    return { ok: false, errors };
  }

  return { ok: true, value: { label: labelResult.data, color: colorResult.data } };
}

/**
 * Validates a raw origin string typed into a server row's inline "change
 * address" field, reusing the same rejection messages `validateNewServerForm`
 * uses so an origin error reads identically everywhere it can appear.
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

/** Renders an optional proxy snapshot (per-server AEM proxy, or the global Copilot proxy) as one display line. */
export function describeProxySnapshot(
  proxy: AemProxySnapshot | CopilotProxySnapshot | undefined,
): string {
  if (!proxy) return 'Not configured (direct connection)';
  const credentials = proxy.credentials;
  if (!credentials) return `${proxy.url} (no proxy credentials)`;
  const passwordState = credentials.hasPassword ? 'password stored' : 'no password stored';
  return `${proxy.url} - user "${credentials.username}" (${passwordState})`;
}
