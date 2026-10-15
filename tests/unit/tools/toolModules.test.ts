import { describe, expect, it } from 'vitest';
import {
  type BrokerOutcome,
  type CurrentAemToolContext,
  type ModelToolModule,
  type ToolEnvelopeBase,
  type ToolHost,
  composeAssistantInstructions,
  newChatId,
  newServerId,
  newTurnId,
} from '../../../src/shared';
import { tool as environmentFactsTool } from '../../../src/tools/environment-facts/tool';
import { tool as getJsonTool } from '../../../src/tools/aem-get-json/tool';
import { tool as queryTool } from '../../../src/tools/aem-query/tool';
import { tool as createPageTool } from '../../../src/tools/aem-create-page/tool';
import { tool as formatTableTool } from '../../../src/tools/format-table/tool';
import { tool as browserNavigateTool } from '../../../src/tools/browser-navigate/tool';
import { tool as askUserTool } from '../../../src/tools/ask-user/tool';
import { createCountingIdGenerator } from '../../support/testIds';

function makeHost(outcome: BrokerOutcome): {
  host: ToolHost;
  calls: Array<{ envelope: ToolEnvelopeBase; url: string }>;
} {
  const ids = createCountingIdGenerator('id');
  const calls: Array<{ envelope: ToolEnvelopeBase; url: string }> = [];
  const context: CurrentAemToolContext = {
    origin: 'https://aem.example.com',
    serverId: newServerId(ids),
    serverRevision: 1,
    navigationEpoch: 0,
    chatId: newChatId(ids),
    turnId: newTurnId(ids),
  };
  return {
    calls,
    host: {
      bridge: {
        request: (envelope, url) => {
          calls.push({ envelope, url });
          return Promise.resolve(outcome);
        },
      },
      currentContext: () => context,
      environmentFacts: () => undefined,
      configuredHosts: () => [],
      openPage: () => Promise.resolve({ kind: 'no_view' }),
      requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
      clock: () => 1_700_000_000_000,
      idGenerator: ids,
      invokeTool: () => Promise.reject(new Error('not used')),
    },
  };
}

const callContext = { toolCallId: 'call-1' as never, signal: undefined };

describe('tool manifests', () => {
  it.each([
    ['aem_get_json', getJsonTool],
    ['aem_query', queryTool],
    ['environment_facts', environmentFactsTool],
    ['aem_create_page', createPageTool],
    ['browser_navigate', browserNavigateTool],
    ['ask_user', askUserTool],
  ])('%s is internally consistent', (name, tool: ModelToolModule) => {
    expect(tool.name).toBe(name);
    expect(tool.descriptor.name).toBe(name);
    expect(tool.allowlistEntry).toBe(`custom:${name}`);
    expect(tool.instructions.length).toBeGreaterThan(0);
  });

  it('exposes format_table as an internal tool with no model-facing surface', () => {
    expect(formatTableTool.name).toBe('format_table');
    expect(formatTableTool.internal).toBe(true);
    // The model never sees it, so the contract lets it omit these entirely.
    expect('descriptor' in formatTableTool).toBe(false);
    expect('allowlistEntry' in formatTableTool).toBe(false);
    expect('instructions' in formatTableTool).toBe(false);
  });

  it('keeps aem_create_page disabled while the bridge has no write transport', () => {
    expect(createPageTool.disabled).toBe(true);
    expect(getJsonTool.disabled).not.toBe(true);
    expect(queryTool.disabled).not.toBe(true);
    expect(environmentFactsTool.disabled).not.toBe(true);
    expect(formatTableTool.disabled).not.toBe(true);
  });
});

describe('aem_get_json module', () => {
  it("routes the fetch through the host bridge with the URL built for the call's own args", async () => {
    const { host, calls } = makeHost({
      kind: 'response',
      status: 200,
      contentType: 'application/json',
      bodyText: '{"jcr:primaryType":"nt:unstructured"}',
    });
    const result = await getJsonTool.createExecutor(host)({ path: '/content/foo' }, callContext);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://aem.example.com/content/foo.0.json');
    expect(calls[0]?.envelope.requestId).toBeDefined();
  });

  it('never reaches the bridge for invalid arguments', async () => {
    const { host, calls } = makeHost({ kind: 'cancelled' });
    const result = await getJsonTool.createExecutor(host)({ path: '/content/../x' }, callContext);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('aem_query module', () => {
  it('targets the QueryBuilder endpoint on the bound origin', async () => {
    const { host, calls } = makeHost({
      kind: 'response',
      status: 200,
      contentType: 'application/json',
      bodyText: JSON.stringify({ success: true, results: 0, total: 0, more: false, hits: [] }),
    });
    const result = await queryTool.createExecutor(host)(
      { predicates: { path: '/content/site' }, limit: 50, offset: 0 },
      callContext,
    );

    expect(result.ok).toBe(true);
    expect(calls[0]?.url.startsWith('https://aem.example.com/bin/querybuilder.json?')).toBe(true);
  });
});

describe('aem_create_page module', () => {
  it('has no executor: createExecutor throws, so it can only ever be skipped', () => {
    const { host } = makeHost({ kind: 'cancelled' });
    expect(() => createPageTool.createExecutor(host)).toThrow(/not wired/);
  });
});

describe('composed session instructions', () => {
  it.each([
    ['no placeholder', 'Policy only.'],
    ['two placeholders', '{{tools}} and {{tools}}'],
  ])('throws for a template with %s', (_name, template) => {
    expect(() => composeAssistantInstructions(template, [])).toThrow();
  });
});
