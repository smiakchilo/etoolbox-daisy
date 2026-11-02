import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CommandResult,
  type CommandRunner,
  createNodeDownloader,
  type NodeDistribution,
  type NodeDownloaderOptions,
  PINNED_NODE_VERSION,
  pinnedNodeDistribution,
} from '../../../../src/main/addons/nodeDownload';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('node-download', 'node-');

afterEach(() => {
  scratch.cleanup();
});

const ARCHIVE_BYTES = Buffer.from('pretend this is a node archive');

function distributionFor(bytes: Buffer): NodeDistribution {
  return {
    url: 'https://example.test/node.zip',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signer: 'Test Signer',
    archive: 'zip',
    directory: 'node-fake',
  };
}

function bodyOf(bytes: Buffer, chunkSize = 7): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + chunkSize)));
      }
      controller.close();
    },
  });
}

function responseOf(bytes: Buffer, init: ResponseInit & { url?: string } = {}): Response {
  const response = new Response(bodyOf(bytes), { status: 200, ...init });
  Object.defineProperty(response, 'url', { value: init.url ?? 'https://example.test/node.zip' });
  return response;
}

interface Harness {
  readonly kept: string;
  readonly work: string;
  readonly commands: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[];
  readonly fetchCalls: string[];
  readonly options: NodeDownloaderOptions;
}

interface HarnessOptions {
  readonly bytes?: Buffer;
  readonly response?: () => Response | Promise<Response>;
  readonly extractCode?: number;
  readonly signatureCode?: number;
  readonly platform?: NodeJS.Platform;
  readonly distribution?: NodeDistribution | undefined;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly overrides?: Partial<NodeDownloaderOptions>;
}

function harness(settings: HarnessOptions = {}): Harness {
  const root = scratch.create();
  const kept = path.join(root, 'node');
  const work = path.join(root, '.node-download');
  const bytes = settings.bytes ?? ARCHIVE_BYTES;
  const distribution =
    'distribution' in settings ? settings.distribution : distributionFor(ARCHIVE_BYTES);
  const commands: Harness['commands'] = [];
  const fetchCalls: string[] = [];

  const runCommand: CommandRunner = (file, args, env): Promise<CommandResult> => {
    commands.push({ file, args, env });
    if (path.basename(file).startsWith('tar')) {
      const code = settings.extractCode ?? 0;
      if (code === 0) {
        const extracted = path.join(work, 'node-fake');
        mkdirSync(extracted, { recursive: true });
        writeFileSync(path.join(extracted, 'node.exe'), 'node');
      }
      return Promise.resolve({ code, output: '' });
    }
    return Promise.resolve({ code: settings.signatureCode ?? 0, output: '' });
  };

  const options: NodeDownloaderOptions = {
    keptNodeDirectory: kept,
    platform: settings.platform ?? 'win32',
    arch: 'x64',
    isAppleSilicon: () => Promise.resolve(false),
    distribution: () => distribution,
    runCommand,
    fetch: () =>
      Promise.resolve((url) => {
        fetchCalls.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
        return Promise.resolve(settings.response?.() ?? responseOf(bytes));
      }),
    ...(settings.maxBytes === undefined ? {} : { maxBytes: settings.maxBytes }),
    ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
    ...settings.overrides,
  };
  return { kept, work, commands, fetchCalls, options };
}

function failureOf(result: Awaited<ReturnType<ReturnType<typeof createNodeDownloader>['ensure']>>) {
  if (result.ok) throw new Error('expected a failure');
  return result.error.reason;
}

describe('createNodeDownloader', () => {
  it('keeps a verified copy and marks it complete last', async () => {
    const h = harness();
    const result = await createNodeDownloader(h.options).ensure();

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(h.kept, 'node.exe'))).toBe(true);
    expect(existsSync(path.join(h.kept, `.pinned-${PINNED_NODE_VERSION}`))).toBe(true);
    expect(existsSync(h.work)).toBe(false);
  });

  it('refuses a hash mismatch before anything is written or extracted', async () => {
    const h = harness({ bytes: Buffer.from('tampered') });
    const result = await createNodeDownloader(h.options).ensure();

    expect(failureOf(result)).toBe('insecure');
    expect(h.commands).toHaveLength(0);
    expect(existsSync(h.work)).toBe(false);
    expect(existsSync(h.kept)).toBe(false);
  });

  it('refuses a signature that does not verify and leaves the kept copy alone', async () => {
    const h = harness({ signatureCode: 1 });
    mkdirSync(h.kept, { recursive: true });
    writeFileSync(path.join(h.kept, 'previous.txt'), 'old');

    const result = await createNodeDownloader(h.options).ensure();

    expect(failureOf(result)).toBe('insecure');
    expect(readdirSync(h.kept)).toEqual(['previous.txt']);
    expect(existsSync(h.work)).toBe(false);
  });

  it('reports an extraction failure as unexpected and keeps nothing', async () => {
    const h = harness({ extractCode: 1 });
    const result = await createNodeDownloader(h.options).ensure();

    expect(failureOf(result)).toBe('unexpected');
    expect(existsSync(h.kept)).toBe(false);
  });

  it('maps a non-ok status to http-status', async () => {
    const h = harness({ response: () => new Response('nope', { status: 404 }) });
    expect(failureOf(await createNodeDownloader(h.options).ensure())).toBe('http-status');
  });

  it('maps a transport error to network', async () => {
    const h = harness({
      response: () => {
        throw new Error('connection reset');
      },
    });
    expect(failureOf(await createNodeDownloader(h.options).ensure())).toBe('network');
  });

  it('maps a missing body to network', async () => {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, 'url', { value: 'https://example.test/node.zip' });
    const h = harness({ response: () => response });

    expect(failureOf(await createNodeDownloader(h.options).ensure())).toBe('network');
  });

  it('maps an exceeded deadline to timeout', async () => {
    const h = harness({
      timeoutMs: 20,
      overrides: {
        fetch: () =>
          Promise.resolve(
            (_url, init) =>
              new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                  reject(new Error('aborted'));
                });
              }),
          ),
      },
    });
    expect(failureOf(await createNodeDownloader(h.options).ensure())).toBe('timeout');
  });

  it('refuses a response that ended up on a non-https address', async () => {
    const h = harness({
      response: () => responseOf(ARCHIVE_BYTES, { url: 'http://example.test/node.zip' }),
    });
    expect(failureOf(await createNodeDownloader(h.options).ensure())).toBe('insecure');
  });

  it('refuses a declared size over the cap without reading the body', async () => {
    const h = harness({
      maxBytes: 10,
      response: () => {
        const response = new Response(new Uint8Array(0), {
          status: 200,
          headers: { 'content-length': String(ARCHIVE_BYTES.length) },
        });
        Object.defineProperty(response, 'url', { value: 'https://example.test/node.zip' });
        Object.defineProperty(response, 'body', {
          get: () => {
            throw new Error('the body must not be read');
          },
        });
        return response;
      },
    });
    expect(failureOf(await createNodeDownloader(h.options).ensure())).toBe('too-large');
  });

  it('refuses a stream that outgrows the cap when no size was declared', async () => {
    const h = harness({ maxBytes: 10 });
    expect(failureOf(await createNodeDownloader(h.options).ensure())).toBe('too-large');
  });

  it('downloads nothing where no distribution exists', async () => {
    const h = harness({ distribution: undefined });
    expect(failureOf(await createNodeDownloader(h.options).ensure())).toBe('no-node');
    expect(h.fetchCalls).toHaveLength(0);
  });

  it('shares one download between concurrent callers', async () => {
    const h = harness();
    const downloader = createNodeDownloader(h.options);
    const [first, second] = await Promise.all([downloader.ensure(), downloader.ensure()]);

    expect(first.ok && second.ok).toBe(true);
    expect(h.fetchCalls).toHaveLength(1);
  });

  it('can download again after a failure', async () => {
    let attempt = 0;
    const h = harness({
      response: () => {
        attempt += 1;
        if (attempt === 1) throw new Error('offline');
        return responseOf(ARCHIVE_BYTES);
      },
    });
    const downloader = createNodeDownloader(h.options);

    expect((await downloader.ensure()).ok).toBe(false);
    expect((await downloader.ensure()).ok).toBe(true);
  });

  it('fetches through the configured fetch', async () => {
    const h = harness();
    const fetcher = vi.fn(h.options.fetch);
    await createNodeDownloader({ ...h.options, fetch: fetcher }).ensure();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('checks the Windows signature with the signer carried in the environment', async () => {
    const h = harness();
    await createNodeDownloader(h.options).ensure();

    const signature = h.commands.find((command) => /powershell/i.test(command.file));
    expect(signature?.env['EDAISY_NODE_SIGNER']).toBe('Test Signer');
    expect(signature?.env['EDAISY_NODE_EXE']).toContain('node.exe');
  });

  it('hands Windows PowerShell no module path, whatever its casing', async () => {
    const saved = { ...process.env };
    process.env['PSModulePath'] = 'C:\\parent\\Modules';
    process.env['psmodulepath'] = 'C:\\other\\Modules';
    try {
      const h = harness();
      await createNodeDownloader(h.options).ensure();

      const signature = h.commands.find((command) => /powershell/i.test(command.file));
      const keys = Object.keys(signature?.env ?? {}).map((key) => key.toLowerCase());
      expect(signature).toBeDefined();
      expect(keys).not.toContain('psmodulepath');
    } finally {
      for (const key of Object.keys(process.env)) {
        if (key.toLowerCase() === 'psmodulepath') delete process.env[key];
      }
      if (saved['PSModulePath'] !== undefined) process.env['PSModulePath'] = saved['PSModulePath'];
    }
  });

  it('verifies a macOS download with codesign and the signing authority', async () => {
    const h = harness({
      platform: 'darwin',
      overrides: {
        runCommand: (file, args) => {
          h.commands.push({ file, args, env: {} });
          if (file.endsWith('tar')) {
            const extracted = path.join(h.work, 'node-fake', 'bin');
            mkdirSync(extracted, { recursive: true });
            writeFileSync(path.join(extracted, 'node'), 'node');
            return Promise.resolve({ code: 0, output: '' });
          }
          return Promise.resolve({
            code: 0,
            output: args.includes('-dvv')
              ? 'Authority=Developer ID Application: Test Signer (X)\n'
              : '',
          });
        },
      },
    });
    const result = await createNodeDownloader(h.options).ensure();

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(h.kept, 'bin', 'node'))).toBe(true);
    expect(h.commands.some((command) => command.args.includes('--verify'))).toBe(true);
  });

  it('refuses a macOS binary signed by someone else', async () => {
    const h = harness({
      platform: 'darwin',
      overrides: {
        runCommand: (file, args) => {
          if (file.endsWith('tar')) {
            const extracted = path.join(h.work, 'node-fake', 'bin');
            mkdirSync(extracted, { recursive: true });
            writeFileSync(path.join(extracted, 'node'), 'node');
            return Promise.resolve({ code: 0, output: '' });
          }
          return Promise.resolve({
            code: 0,
            output: args.includes('-dvv')
              ? 'Authority=Developer ID Application: Someone Else\n'
              : '',
          });
        },
      },
    });
    expect(failureOf(await createNodeDownloader(h.options).ensure())).toBe('insecure');
    expect(existsSync(h.kept)).toBe(false);
  });
});

describe('pinnedNodeDistribution', () => {
  it('selects the Windows x64 zip', () => {
    const distribution = pinnedNodeDistribution('win32', 'x64', false);
    expect(distribution?.archive).toBe('zip');
    expect(distribution?.url).toContain(`v${PINNED_NODE_VERSION}`);
    expect(distribution?.url).toContain('win-x64');
  });

  it('selects the macOS build by the hardware', () => {
    expect(pinnedNodeDistribution('darwin', 'x64', true)?.url).toContain('darwin-arm64');
    expect(pinnedNodeDistribution('darwin', 'arm64', false)?.url).toContain('darwin-x64');
  });

  it('has none for a platform the install scripts do not support', () => {
    expect(pinnedNodeDistribution('linux', 'x64', false)).toBeUndefined();
    expect(pinnedNodeDistribution('win32', 'arm64', false)).toBeUndefined();
  });
});
