import { describe, expect, it } from 'vitest';
import {
  composeAssistantInstructions,
  newChatId,
  newServerId,
  newTurnId,
  type BrokerOutcome,
  type CurrentAemToolContext,
  type ToolEnvelopeBase,
  type ToolHost,
  type ToolModule,
} from '../../../src/shared';
import { tool as environmentFactsTool } from '../../../src/tools/aem-environment-facts/tool';
import { tool as getJsonTool } from '../../../src/tools/aem-get-json/tool';
import { tool as queryTool } from '../../../src/tools/aem-query/tool';
import { tool as createPageTool } from '../../../src/tools/aem-create-page/tool';
import { tool as formatTableTool } from '../../../src/tools/format-table/tool';
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
      requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
      clock: () => 1_700_000_000_000,
      idGenerator: ids,
    },
  };
}

const callContext = { toolCallId: 'call-1' as never, signal: undefined };

describe('tool manifests', () => {
  it.each([
    ['aem_get_json', getJsonTool],
    ['aem_query', queryTool],
    ['aem_environment_facts', environmentFactsTool],
    ['format_table', formatTableTool],
    ['aem_create_page', createPageTool],
  ])('%s is internally consistent', (name, tool: ToolModule) => {
    expect(tool.name).toBe(name);
    expect(tool.descriptor.name).toBe(name);
    expect(tool.allowlistEntry).toBe(`custom:${name}`);
    expect(tool.instructions.length).toBeGreaterThan(0);
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
  const composed = composeAssistantInstructions([getJsonTool.instructions, queryTool.instructions]);

  it('states that the session is read-only and forbids side-channel routes', () => {
    expect(composed).toMatch(/strictly read-only against AEM/i);
    expect(composed).toMatch(/Sling POST servlet/);
    expect(composed).toMatch(/never put a host, scheme, port, or full URL into a tool argument/i);
  });

  it('tells the model to page through query results and never present one page as complete', () => {
    expect(composed).toMatch(/higher 'offset'/);
    expect(composed).toMatch(/never present one page as the complete set/i);
  });

  it('names exactly the tools whose fragments were supplied', () => {
    expect(composed).toContain("'aem_get_json'");
    expect(composed).toContain("'aem_query'");
    expect(composed).not.toContain('aem_create_page');
  });

  it('with no tools still frames the session and closes on error handling', () => {
    const empty = composeAssistantInstructions([]);
    expect(empty).toMatch(/read-only assistant/);
    expect(empty).toMatch(/If a tool reports an error/);
  });
});
