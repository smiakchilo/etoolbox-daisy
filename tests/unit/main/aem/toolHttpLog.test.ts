import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolHttpLogger, type ToolHttpLogger } from '../../../../src/main/aem/toolHttpLog';

/**
 * Scratch directories live under the project's own `test-results/` (already
 * gitignored), never an OS temp directory - matching
 * tests/unit/main/logger.test.ts.
 */
const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'tool-http-log-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readRecords(dir: string, fileName = 'tools.log'): Record<string, unknown>[] {
  try {
    return readFileSync(path.join(dir, fileName), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe('createToolHttpLogger: writes the HTTP detail app.log must not carry', () => {
  it('records the full request URL including its query string, plus the headers', () => {
    const dir = createScratchRoot();
    const logger = createToolHttpLogger(dir, { now: () => 1_700_000_000_000 });

    logger.request({
      requestId: 'req-1',
      method: 'GET',
      url: 'https://author.example/bin/querybuilder.json?path=/content/foo&type=cq:Page',
      headers: [{ name: 'Accept', value: 'application/json' }],
    });

    const records = readRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      recordType: 'tool.http.request',
      requestId: 'req-1',
      method: 'GET',
      url: 'https://author.example/bin/querybuilder.json?path=/content/foo&type=cq:Page',
      headers: [{ name: 'Accept', value: 'application/json' }],
    });
    expect(records[0]?.['ts']).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('records the response status, outcome, duration and headers', () => {
    const dir = createScratchRoot();
    const logger = createToolHttpLogger(dir);

    logger.response({
      requestId: 'req-2',
      status: 200,
      outcome: 'success',
      durationMs: 42,
      headers: [{ name: 'content-type', value: 'application/json' }],
    });

    const records = readRecords(dir);
    expect(records[0]).toMatchObject({
      recordType: 'tool.http.response',
      requestId: 'req-2',
      status: 200,
      outcome: 'success',
      durationMs: 42,
      headers: [{ name: 'content-type', value: 'application/json' }],
    });
  });

  it('records a settlement with no response as a null status and an empty header list', () => {
    const dir = createScratchRoot();
    const logger = createToolHttpLogger(dir);

    logger.response({
      requestId: 'req-3',
      status: null,
      outcome: 'timeout',
      durationMs: 90_000,
      headers: [],
    });

    expect(readRecords(dir)[0]).toMatchObject({
      recordType: 'tool.http.response',
      status: null,
      outcome: 'timeout',
      durationMs: 90_000,
      headers: [],
    });
  });

  it('records the tool classification once the body has been read', () => {
    // The record that stops a 200 that carried no JSON from standing as an
    // outright success: "empty_response" is the Oak-traversal abort.
    const dir = createScratchRoot();
    const logger = createToolHttpLogger(dir, { now: () => 1_700_000_000_000 });

    logger.classification({ requestId: 'req-7', kind: 'empty_response' });

    const records = readRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      recordType: 'tool.http.classified',
      requestId: 'req-7',
      kind: 'empty_response',
    });
    expect(records[0]?.['ts']).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe('createToolHttpLogger: header values are sanitized', () => {
  it('redacts credential-bearing header names even though the browser withholds them', () => {
    const dir = createScratchRoot();
    const logger = createToolHttpLogger(dir);

    logger.response({
      requestId: 'req-4',
      status: 200,
      outcome: 'success',
      durationMs: 1,
      headers: [
        { name: 'Set-Cookie', value: 'session=CANARY-COOKIE' },
        { name: 'Authorization', value: 'Bearer CANARY-TOKEN' },
        { name: 'X-Aem-Path', value: '/content/foo' },
      ],
    });

    const raw = readFileSync(path.join(dir, 'tools.log'), 'utf8');
    expect(raw).not.toContain('CANARY-COOKIE');
    expect(raw).not.toContain('CANARY-TOKEN');
    expect(raw).toContain('"name":"Set-Cookie","value":"[redacted]"');
    expect(raw).toContain('"name":"Authorization","value":"[redacted]"');
    expect(raw).toContain('"value":"/content/foo"');
  });

  it('flattens CR/LF so a crafted header value cannot forge a second log line', () => {
    const dir = createScratchRoot();
    const logger = createToolHttpLogger(dir);

    logger.response({
      requestId: 'req-5',
      status: 200,
      outcome: 'success',
      durationMs: 1,
      headers: [{ name: 'X-Injected', value: 'a\r\n{"recordType":"tool.http.response"}' }],
    });

    const records = readRecords(dir);
    // Exactly one record: the CR/LF became spaces rather than starting a new line.
    expect(records).toHaveLength(1);
    expect(records[0]?.['headers']).toEqual([
      { name: 'X-Injected', value: 'a {"recordType":"tool.http.response"}' },
    ]);
  });
});

describe('createToolHttpLogger: a write failure does not throw and is observable', () => {
  it('records the failure on its health instead of throwing', () => {
    const dir = createScratchRoot();
    const blockerFilePath = path.join(dir, 'blocked');
    mkdirSync(dir, { recursive: true });
    writeFileSync(blockerFilePath, 'not a directory');

    let logger: ToolHttpLogger | undefined;
    expect(() => {
      logger = createToolHttpLogger(blockerFilePath);
    }).not.toThrow();

    expect(() => {
      logger?.request({
        requestId: 'req-6',
        method: 'GET',
        url: 'https://author.example/x.json',
        headers: [],
      });
    }).not.toThrow();

    expect(logger?.getHealth().writeFailureCount).toBeGreaterThan(0);
  });
});
