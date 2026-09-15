import '@spectrum-web-components/theme/sp-theme.js';
import '@spectrum-web-components/theme/theme-light.js';
import '@spectrum-web-components/theme/scale-medium.js';
import '@spectrum-web-components/button/sp-button.js';
import '@spectrum-web-components/textfield/sp-textfield.js';
import '@spectrum-web-components/status-light/sp-status-light.js';
import '@spectrum-web-components/action-menu/sp-action-menu.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-chevron-down.js';
import '@spectrum-web-components/menu/sp-menu-item.js';
import '@spectrum-web-components/picker/sp-picker.js';
import '@spectrum-web-components/checkbox/sp-checkbox.js';
import './styles/settings.css';
import { mountSettingsShell } from './settingsWindow/settingsShell';

async function render(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('Settings window root element #app is missing');
  }

  const theme = document.createElement('sp-theme');
  theme.setAttribute('system', 'spectrum');
  theme.setAttribute('color', 'light');
  theme.setAttribute('scale', 'medium');
  root.appendChild(theme);

  await mountSettingsShell(theme);
}

void render();
