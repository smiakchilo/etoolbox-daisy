import '@spectrum-web-components/theme/sp-theme.js';
import '@spectrum-web-components/theme/theme-light.js';
import '@spectrum-web-components/theme/scale-medium.js';
import '@spectrum-web-components/button/sp-button.js';
import '@spectrum-web-components/textfield/sp-textfield.js';
import '@spectrum-web-components/field-label/sp-field-label.js';
import '@spectrum-web-components/status-light/sp-status-light.js';
import '@spectrum-web-components/progress-circle/sp-progress-circle.js';
import '@spectrum-web-components/action-button/sp-action-button.js';
import '@spectrum-web-components/picker-button/sp-picker-button.js';
import '@spectrum-web-components/divider/sp-divider.js';
import '@spectrum-web-components/split-view/sp-split-view.js';
import '@spectrum-web-components/alert-banner/sp-alert-banner.js';
import '@spectrum-web-components/table/sp-table.js';
import '@spectrum-web-components/table/sp-table-head.js';
import '@spectrum-web-components/table/sp-table-head-cell.js';
import '@spectrum-web-components/table/sp-table-body.js';
import '@spectrum-web-components/table/sp-table-row.js';
import '@spectrum-web-components/table/sp-table-cell.js';
import '@spectrum-web-components/icons-ui/icons/sp-icon-arrow400.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-refresh.js';
import '@spectrum-web-components/icons-ui/icons/sp-icon-cross400.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-chat-add.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-history.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-settings.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-chevron-down.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-chevron-up.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-delete-outline.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-add.js';
import '@spectrum-web-components/action-menu/sp-action-menu.js';
import '@spectrum-web-components/menu/sp-menu-item.js';
import '@spectrum-web-components/picker/sp-picker.js';
import '@spectrum-web-components/checkbox/sp-checkbox.js';
import '@spectrum-web-components/tabs/sp-tabs.js';
import '@spectrum-web-components/tabs/sp-tab.js';
import '@spectrum-web-components/tabs/sp-tab-panel.js';
import './styles/base.css';
import './styles/panel.css';
import './styles/banner.css';
import './styles/browser.css';
import './styles/chat.css';
import './styles/settings.css';
import { installTextfieldPlaceholderColor } from './lib/textfieldPlaceholder';
import { mountMainShell } from './shell/mainShell';

async function render(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('Renderer root element #app is missing');
  }

  // Every text field's placeholder reads as gray, distinct from the value.
  // Installed before the shell mounts so the first render already has it.
  installTextfieldPlaceholderColor();

  const theme = document.createElement('sp-theme');
  theme.setAttribute('system', 'spectrum');
  theme.setAttribute('color', 'light');
  theme.setAttribute('scale', 'medium');
  root.appendChild(theme);

  // tests/e2e/app.spec.ts asserts on #daisy-hello-button/#daisy-app-info,
  // and that test is owned by another agent, so these stay mounted. They are
  // relocated into the chat pane's internally-scrolling transcript region
  // (via `chatFooterContent`) instead of being appended after the shell, so
  // they cannot grow the document past the viewport - see
  // `styles/base.css`'s "document never scrolls" layout contract.
  const divider = document.createElement('sp-divider');
  divider.setAttribute('size', 's');

  const button = document.createElement('sp-button');
  button.setAttribute('variant', 'accent');
  button.id = 'daisy-hello-button';
  button.textContent = 'EToolbox Daisy skeleton';

  const info = await window.daisy.getAppInfo();
  const infoLine = document.createElement('p');
  infoLine.id = 'daisy-app-info';
  infoLine.textContent = `${info.name} v${info.version}`;

  await mountMainShell(theme, {
    chatFooterContent: [divider, button, infoLine],
  });
}

void render();
