import '@spectrum-web-components/theme/sp-theme.js';
import '@spectrum-web-components/theme/theme-light.js';
import '@spectrum-web-components/theme/scale-medium.js';
import '@spectrum-web-components/button/sp-button.js';
import '@spectrum-web-components/button/sp-close-button.js';
import '@spectrum-web-components/textfield/sp-textfield.js';
import '@spectrum-web-components/field-label/sp-field-label.js';
import '@spectrum-web-components/contextual-help/sp-contextual-help.js';
import '@spectrum-web-components/status-light/sp-status-light.js';
import '@spectrum-web-components/action-button/sp-action-button.js';
import '@spectrum-web-components/picker-button/sp-picker-button.js';
import '@spectrum-web-components/split-view/sp-split-view.js';
import '@spectrum-web-components/alert-banner/sp-alert-banner.js';
import '@spectrum-web-components/overlay/sp-overlay.js';
import '@spectrum-web-components/popover/sp-popover.js';
import '@spectrum-web-components/progress-circle/sp-progress-circle.js';
import '@spectrum-web-components/table/sp-table.js';
import '@spectrum-web-components/table/sp-table-head.js';
import '@spectrum-web-components/table/sp-table-head-cell.js';
import '@spectrum-web-components/table/sp-table-body.js';
import '@spectrum-web-components/table/sp-table-row.js';
import '@spectrum-web-components/table/sp-table-cell.js';
import '@spectrum-web-components/icons-ui/icons/sp-icon-arrow400.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-refresh.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-replay.js';
import '@spectrum-web-components/icons-ui/icons/sp-icon-cross600.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-chat-add.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-history.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-home.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-settings.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-padding-right.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-chevron-down.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-edit.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-journey-voyager.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-chevron-up.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-delete-outline.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-add.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-send.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-actions.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-open-in-light.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-file-txt.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-copy.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-export.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-undo.js';
import '@spectrum-web-components/action-menu/sp-action-menu.js';
import '@spectrum-web-components/menu/sp-menu.js';
import '@spectrum-web-components/menu/sp-menu-item.js';
import '@spectrum-web-components/picker/sp-picker.js';
import '@spectrum-web-components/checkbox/sp-checkbox.js';
import '@spectrum-web-components/radio/sp-radio.js';
import '@spectrum-web-components/radio/sp-radio-group.js';
import '@spectrum-web-components/tabs/sp-tabs.js';
import '@spectrum-web-components/tabs/sp-tab.js';
import '@spectrum-web-components/tabs/sp-tab-panel.js';
import './styles/base.css';
import './styles/panel.css';
import './styles/banner.css';
import './styles/browser.css';
import './styles/home.css';
import './styles/chat.css';
import './styles/settings.css';
import './styles/history.css';
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

  await mountMainShell(theme);
}

void render();
