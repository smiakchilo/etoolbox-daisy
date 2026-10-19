import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEARCH_PAGE_SIZE, resolveSearchPageSize } from '../../../src/shared';
import {
  AEM_QUERY_TOOL_DESCRIPTOR,
  aemQueryArgsSchema,
} from '../../../src/tools/aem-query/aemQuery';
import { aemQueryFormatAskArgsSchema } from '../../../src/tools/aem-query-format-ask/aemQueryFormatAsk';
import { aemSemanticSearchArgsSchema } from '../../../src/tools/aem-semantic-search/aemSemanticSearch';

/**
 * The one page size, held across every model-facing search tool and every
 * bundled skill.
 *
 * `SEARCH_PAGE_SIZE` is the only page-size definition in the application: the
 * tools default to it, a call may still override it explicitly, and a skill
 * never carries a page-size assignment of its own (the application owns
 * paging - see `resources/rules/session.md`).
 */
const skillsDir = path.join(process.cwd(), 'resources', 'skills');

const bundledSkills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    text: readFileSync(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf8'),
  }));

/** Any way a skill could hand the model its own page size. */
const LIMIT_ASSIGNMENT = /(?:["'`]limit["'`]|\blimit)\s*:/;

describe('the one search page size', () => {
  it('is the default of a plain aem_query call', () => {
    expect(aemQueryArgsSchema.parse({ predicates: {} }).limit).toBe(SEARCH_PAGE_SIZE);
  });

  it('is the default of an aem_query_format_ask call', () => {
    expect(aemQueryFormatAskArgsSchema.parse({ terms: 'waldo' }).limit).toBe(SEARCH_PAGE_SIZE);
  });

  it('is the fallback a semantic search applies after parsing', () => {
    expect(aemSemanticSearchArgsSchema.parse({ terms: 'waldo', context: 'good' }).limit).toBe(
      undefined,
    );
    expect(resolveSearchPageSize(undefined)).toBe(SEARCH_PAGE_SIZE);
  });

  it('still accepts an explicit limit as an override', () => {
    expect(aemQueryArgsSchema.parse({ predicates: {}, limit: 50 }).limit).toBe(50);
    expect(aemQueryFormatAskArgsSchema.parse({ terms: 'waldo', limit: 50 }).limit).toBe(50);
    expect(
      aemSemanticSearchArgsSchema.parse({ terms: 'waldo', context: 'good', limit: 50 }).limit,
    ).toBe(50);
  });

  it('is the number the aem_query descriptor advertises', () => {
    expect(AEM_QUERY_TOOL_DESCRIPTOR.description).toContain(
      `defaults to ${String(SEARCH_PAGE_SIZE)}`,
    );
  });

  it.each(bundledSkills)('$name leaves the page size to the application', ({ text }) => {
    expect(text).not.toMatch(LIMIT_ASSIGNMENT);
  });
});
