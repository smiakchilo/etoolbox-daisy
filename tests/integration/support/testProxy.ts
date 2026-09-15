import http, { type IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import type { GeneratedCert } from './testCa';

/**
 * One entry per event the test proxy observed, kept append-only so tests can
 * assert both "this happened" and "nothing else did" (the no-hidden-bypass
 * requirement in requirements-decisions.md §4 / implementation-plan.md
 * Step 02: a proxy error must never fall back to a direct connection).
 */
export type ProxyLogEntry =
  | {
      readonly kind: 'connect-attempt';
      readonly target: string;
      readonly authHeaderPresent: boolean;
    }
  | { readonly kind: 'connect-rejected-407'; readonly target: string; readonly reason: string }
  | { readonly kind: 'connect-forward-error'; readonly target: string; readonly message: string }
  | { readonly kind: 'tls-handshake'; readonly target: string; readonly outcome: 'success' }
  | { readonly kind: 'tls-handshake-error'; readonly target: string; readonly message: string }
  | { readonly kind: 'mitm-request'; readonly target: string; readonly requestLine: string }
  | { readonly kind: 'plain-http-forward'; readonly method: string; readonly url: string };

export interface BasicAuthCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Builds a proxy URL with embedded Basic-auth credentials using the `URL`
 * object's `username`/`password` setters, so the assembled `scheme://user:
 * pass@host` string only ever exists at runtime - never as a literal
 * substring in this repository's source (avoids tripping credential-shaped
 * string scanners on a harmless, locally-generated test password).
 */
export function withEmbeddedCredentials(
  baseUrl: string,
  credentials: BasicAuthCredentials,
): string {
  const url = new URL(baseUrl);
  url.username = encodeURIComponent(credentials.username);
  url.password = encodeURIComponent(credentials.password);
  return url.toString();
}

export interface MitmOptions {
  /** Returns the certificate to present for a given CONNECT target hostname. */
  readonly certFor: (hostname: string) => Promise<GeneratedCert> | GeneratedCert;
  /**
   * Raw HTTP response bytes written after a successful TLS handshake once a
   * request is observed. Defaults to a minimal valid JSON 200 response.
   */
  readonly response?: string;
}

export interface TestProxyOptions {
  /** When set, CONNECT (and plain HTTP forwarding) requires this Basic auth. */
  readonly auth?: BasicAuthCredentials;
  /**
   * When set, the proxy terminates TLS itself for CONNECT tunnels (MITM
   * mode) instead of transparently piping bytes to the real target. Used for
   * the trusted/untrusted corporate CA matrix cases.
   */
  readonly mitm?: MitmOptions;
}

export interface TestProxyHandle {
  readonly port: number;
  /** `http://127.0.0.1:<port>` - no embedded credentials. */
  readonly url: string;
  readonly log: readonly ProxyLogEntry[];
  close(): Promise<void>;
}

/**
 * Reserves then immediately releases a free TCP port on 127.0.0.1, so tests
 * can point `HTTPS_PROXY` at an address nothing is listening on (the
 * "unreachable proxy" matrix case) without relying on a hardcoded port that
 * might be in use.
 */
export async function reserveClosedPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
    probe.on('error', reject);
  });
}

function checkBasicAuth(
  req: IncomingMessage,
  expected: BasicAuthCredentials,
): { ok: boolean; reason: string } {
  const header = req.headers['proxy-authorization'];
  if (!header || Array.isArray(header)) return { ok: false, reason: 'missing' };
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return { ok: false, reason: 'malformed' };
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  const username = separatorIndex === -1 ? decoded : decoded.slice(0, separatorIndex);
  const password = separatorIndex === -1 ? '' : decoded.slice(separatorIndex + 1);
  if (username === expected.username && password === expected.password)
    return { ok: true, reason: '' };
  return { ok: false, reason: 'bad-credentials' };
}

const DEFAULT_MITM_RESPONSE =
  'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}';

/**
 * A local HTTP(S) forward proxy for the Step 02 proxy/TLS matrix
 * (implementation-plan.md lines ~161-181): supports plain HTTP forwarding,
 * `CONNECT` tunnelling (transparent pipe, real network egress to the actual
 * requested host), optional Basic `Proxy-Authorization` (returning `407` +
 * `Proxy-Authenticate` on bad/missing credentials), and - when `mitm` is
 * supplied - terminates the CONNECT tunnel's TLS itself using a
 * caller-supplied certificate instead of forwarding, so tests can prove
 * trusted/untrusted corporate CA behavior without depending on any real
 * upstream server.
 */
export async function startTestProxy(options: TestProxyOptions = {}): Promise<TestProxyHandle> {
  const log: ProxyLogEntry[] = [];
  // Sockets hijacked via the 'connect' event (both the raw tunnel and the
  // MITM TLS-wrapping ones) are detached from the http.Server's own
  // connection bookkeeping once the 'connect' handler runs - Node's
  // `server.close()`/`closeAllConnections()` only account for sockets it is
  // still driving as HTTP requests, so a CONNECT tunnel left open (as the
  // runtime's keep-alive HTTPS agent does) would otherwise make
  // `server.close()` hang forever waiting for a socket it no longer knows
  // about. Track and force-close them ourselves.
  const hijackedSockets = new Set<Duplex>();

  const server = http.createServer((req, res) => {
    // Plain HTTP absolute-URI forwarding (rarely exercised by the real app,
    // which only ever proxies HTTPS to GitHub/Copilot, but required by the
    // step's "supports both plain HTTP forwarding and CONNECT" instruction).
    log.push({ kind: 'plain-http-forward', method: req.method ?? '', url: req.url ?? '' });
    if (options.auth) {
      const authResult = checkBasicAuth(req, options.auth);
      if (!authResult.ok) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="daisy-test-proxy"' });
        res.end();
        return;
      }
    }
    let targetUrl: URL;
    try {
      targetUrl = new URL(req.url ?? '');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const upstreamReq = http.request(
      {
        host: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstreamReq);
  });

  server.on('connect', (req, clientSocket, head) => {
    const target = req.url ?? '';
    const authHeaderPresent = Boolean(req.headers['proxy-authorization']);
    log.push({ kind: 'connect-attempt', target, authHeaderPresent });

    hijackedSockets.add(clientSocket);
    clientSocket.on('close', () => hijackedSockets.delete(clientSocket));

    if (options.auth) {
      const authResult = checkBasicAuth(req, options.auth);
      if (!authResult.ok) {
        log.push({ kind: 'connect-rejected-407', target, reason: authResult.reason });
        clientSocket.end(
          `HTTP/1.1 407 Proxy Authentication Required\r\n` +
            `Proxy-Authenticate: Basic realm="daisy-test-proxy"\r\n\r\n`,
        );
        return;
      }
    }

    const [hostname, portStr] = target.split(':');
    const port = Number(portStr) || 443;
    if (!hostname) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    if (options.mitm) {
      const { mitm } = options;
      void (async () => {
        let leaf: GeneratedCert;
        try {
          leaf = await mitm.certFor(hostname);
        } catch (err) {
          log.push({
            kind: 'connect-forward-error',
            target,
            message: err instanceof Error ? err.message : String(err),
          });
          clientSocket.end();
          return;
        }
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const tlsSocket = new tls.TLSSocket(clientSocket, {
          isServer: true,
          key: leaf.key,
          cert: leaf.cert,
        });
        let requestLogged = false;
        tlsSocket.on('secure', () => {
          log.push({ kind: 'tls-handshake', target, outcome: 'success' });
        });
        tlsSocket.on('data', (chunk: Buffer) => {
          if (!requestLogged) {
            requestLogged = true;
            const requestLine = chunk.toString('utf8').split('\r\n')[0] ?? '';
            log.push({ kind: 'mitm-request', target, requestLine });
          }
          tlsSocket.end(mitm.response ?? DEFAULT_MITM_RESPONSE);
        });
        tlsSocket.on('error', (err: Error) => {
          log.push({ kind: 'tls-handshake-error', target, message: err.message });
        });
        if (head.length > 0) tlsSocket.unshift(head);
      })();
      return;
    }

    // Transparent tunnel: real forwarding to the actual requested host.
    const upstream = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    hijackedSockets.add(upstream);
    upstream.on('close', () => hijackedSockets.delete(upstream));
    upstream.on('error', (err) => {
      log.push({ kind: 'connect-forward-error', target, message: err.message });
      clientSocket.end();
    });
    clientSocket.on('error', () => {
      upstream.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${String(port)}`,
    log,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // The runtime may hold a CONNECT tunnel open (HTTP keep-alive), so a
        // plain graceful `server.close()` would hang waiting for a socket the
        // client never voluntarily closes. `closeAllConnections()` only
        // covers sockets the http.Server itself is still driving, which does
        // NOT include sockets hijacked via the 'connect' event (Node detaches
        // those from its own bookkeeping once the handler runs) - destroy
        // those explicitly, too. This test proxy's job is done once the test
        // has read its log.
        for (const socket of hijackedSockets) socket.destroy();
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
