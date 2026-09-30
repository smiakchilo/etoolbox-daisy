import { type ToolModule } from '../../shared';
import {
  AEM_CREATE_PAGE_ALLOWLIST_ENTRY,
  AEM_CREATE_PAGE_TOOL_DESCRIPTOR,
  AEM_CREATE_PAGE_TOOL_NAME,
} from './aemCreatePage';

/**
 * Disabled: the AEM bridge is GET-only, so this tool has no transport for its
 * POST. A disabled tool is still type-checked but is never registered,
 * allowlisted or described to the model. Enabling it means wiring a write
 * transport (`ToolHost.bridge`), removing `disabled`, and reconciling the
 * shared "read-only" session instructions.
 */
export const tool: ToolModule = {
  name: AEM_CREATE_PAGE_TOOL_NAME,
  descriptor: AEM_CREATE_PAGE_TOOL_DESCRIPTOR,
  allowlistEntry: AEM_CREATE_PAGE_ALLOWLIST_ENTRY,
  disabled: true,
  instructions:
    "The 'aem_create_page' tool creates one new page under an existing parent, and only when " +
    'the user explicitly asks for it.',
  createExecutor: () => {
    throw new Error('aem_create_page is not wired: the AEM bridge has no write transport.');
  },
};
