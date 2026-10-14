import { type ModelToolModule } from '../../shared';
import {
  BROWSER_NAVIGATE_ALLOWLIST_ENTRY,
  BROWSER_NAVIGATE_TOOL_DESCRIPTOR,
  BROWSER_NAVIGATE_TOOL_NAME,
  createBrowserNavigateExecutor,
} from './browserNavigate';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ModelToolModule = {
  name: BROWSER_NAVIGATE_TOOL_NAME,
  descriptor: BROWSER_NAVIGATE_TOOL_DESCRIPTOR,
  allowlistEntry: BROWSER_NAVIGATE_ALLOWLIST_ENTRY,
  instructions:
    'Opens a page, asset or standard AEM place in the browser pane. For any request to open, ' +
    'load, go to or navigate to something, load the `navigate` skill first. A page the user ' +
    'names MUST be resolved first: call aem_query and open only the jcr:path it returns - ' +
    "never construct a path from a name ('the home page' is not '/content/<site>/us/en'). Name " +
    'the host by its LABEL (learn labels with environment_facts) - never by a URL - or omit it ' +
    'to use the host the pane is on. Then pass exactly one of: `place` for a standard place, only when the user names the tool or console itself - never for a page name ' +
    '(crxde, package_manager, sites, assets, system_console, config_manager, bundles, ' +
    'osgi_components, sling_logs, jmx - the application owns the path, never type one), or ' +
    '`path`, the raw repository path from aem_query, optionally with a display mode ("view", ' +
    '"edit", "sites" or its alias "admin", "assets", "crxde", "asset_details", "properties"). ' +
    'The application builds the browser URL and owns every .html rule - never append or strip ' +
    '.html yourself. Without a mode, `path` is a verbatim browser path the user literally ' +
    'wrote. Never reach AEM by any route other than a normal page load.',
  createExecutor: (host) => createBrowserNavigateExecutor(host),
};
