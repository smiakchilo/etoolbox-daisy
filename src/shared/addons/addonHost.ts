import type { ToolDescriptor, ToolExecutor } from '../tools';
import type { ToolHost } from '../tools';

/**
 * The interface between the application and an add-on: the two things the
 * application knows about it, and nothing else.
 *
 * An add-on is a self-contained child application, like a DLL. It owns its
 * behaviour, its third-party libraries, its window and its session hardening.
 * The host process knows it only through its **pins entry** (its identity, its
 * `apiVersion` and what it contributes - plain data, see `./contribution.ts`)
 * and through the generic interface below, which carries no add-on's name and
 * none of its domain vocabulary.
 *
 * The window and session types are generic because this module is shared code:
 * the add-on instantiates them as Electron's own `BrowserWindow` and `Session`
 * with `import type`, and this module stays free of Electron.
 *
 * Any change to this interface's shape bumps {@link ADDON_API_VERSION}: a
 * downloaded add-on is code from an older (or newer) build, and it may only run
 * against the host it was written for.
 */
export const ADDON_API_VERSION = 1;

/** What one contributed tool's factory receives, and what it must return. */
export type AddonToolFactory = (toolHost: ToolHost, descriptor: ToolDescriptor) => ToolExecutor;

/** What {@link AddonModule.activate} answers: one factory per declared tool name. */
export interface AddonActivation {
  readonly tools: Readonly<Record<string, AddonToolFactory>>;
}

/**
 * An add-on's entry module: the shape the application loads and checks. The
 * export is named `addon` (see `docs/addon-architecture.md`).
 */
export interface AddonModule<TWindow = unknown, TSession = unknown> {
  /** Must equal the pins entry's `apiVersion` and this build's {@link ADDON_API_VERSION}. */
  readonly apiVersion: number;
  activate(host: AddonHost<TWindow, TSession>): AddonActivation;
}

/**
 * The options an add-on may ask for when it needs a hidden window. Everything
 * here is construction-only in Electron, so the add-on supplies it up front.
 */
export interface AddonHiddenWindowOptions<TSession> {
  /** A session {@link AddonHost.sessions} handed out; any other is refused. */
  readonly session: TSession;
  readonly offscreen?: boolean;
  readonly backgroundThrottling?: boolean;
  readonly width?: number;
  readonly height?: number;
}

/** What the application's address policy decided about one target. */
export interface NetworkTargetVerdict {
  readonly allowed: boolean;
}

/**
 * What an add-on may report to the application's diagnostics log. It is data,
 * not text: the application writes its own generic code and the add-on's id.
 */
export type AddonLogEvent = { readonly code: 'runtime-failed' };

/**
 * Everything an add-on may ask of the host process: an off-screen window, the
 * sessions, the address policy, the configured origins, the page the browser is
 * showing, and a log line.
 *
 * The host forces only the safety-critical window options (hidden, sandboxed,
 * context-isolated, no Node integration, web security on). Everything else -
 * frame rate, background throttling, window-open denial, permissions, the
 * request filter, navigation guards, its own deadline - is the add-on's, and
 * the host does not claim to sandbox it.
 */
export interface AddonHost<TWindow, TSession> {
  /** The add-on's own id, as the pins name it. */
  readonly id: string;
  readonly browser: {
    createHiddenWindow(options: AddonHiddenWindowOptions<TSession>): TWindow;
  };
  readonly sessions: {
    /** The browser pane's session: a configured host's page loads signed in. */
    pane(): TSession;
    /**
     * A session of the add-on's own, with no stored state. Its partition is
     * `addon-<id>-<name>`, so two add-ons can never share one.
     */
    isolated(name: string): TSession;
  };
  readonly network: {
    /**
     * The application's shared address policy: whether a URL may be requested.
     * It resolves names and refuses local, private and internal addresses - and
     * when the application reaches the network through a proxy it delegates
     * address policy to that proxy (see `docs/compatibility.md` §11.8).
     */
    inspectTarget(url: string): Promise<NetworkTargetVerdict>;
  };
  readonly hosts: { isConfiguredOrigin(origin: string): boolean };
  readonly pane: { currentUrl(): string | undefined };
  /** One diagnostics line. The application owns the code, its fields and its file. */
  log(event: AddonLogEvent): void;
}
