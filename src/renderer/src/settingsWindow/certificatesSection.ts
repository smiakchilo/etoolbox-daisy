import { el } from '../lib/dom';
import type { CertificateBlockedInfo, ServerSnapshot } from '../../../shared';
import { describeTlsException } from './viewModel';

export interface CertificatesSection {
  readonly element: HTMLElement;
  update(servers: readonly ServerSnapshot[]): void;
  /** Unsubscribes from `onCertificateBlocked`. */
  dispose(): void;
}

/**
 * Certificate exceptions (requirements-decisions.md section 4).
 *
 * "Awaiting approval" lists live `browser:certificate-blocked` pushes: a
 * human inspects the origin/fingerprint/error class shown here and only
 * then approves it for one specific configured server - never by typing a
 * fingerprint in by hand. Approving requires a configured server whose
 * origin matches the blocked one; there is deliberately no way to approve
 * an exception for a server that does not exist yet (that would be exactly
 * the silent-server-creation requirements-decisions.md section 3 forbids).
 *
 * The recorded-exceptions list below it is read-only display plus a
 * "Remove" action (`revokeCertificateException`).
 */
export function createCertificatesSection(onExceptionChanged: () => void): CertificatesSection {
  let servers: readonly ServerSnapshot[] = [];
  let pending: readonly CertificateBlockedInfo[] = [];

  const statusText = el('p', { attrs: { class: 'certificate-list__status' } });

  const pendingEmptyNotice = el('p', {
    attrs: { class: 'certificate-list__empty' },
    text: 'No blocked certificates awaiting approval.',
  });
  const pendingList = el('ul', { attrs: { class: 'certificate-list' } });

  const emptyNotice = el('p', {
    attrs: { class: 'certificate-list__empty' },
    text: 'No certificate exceptions recorded.',
  });
  const list = el('ul', { attrs: { class: 'certificate-list' } });

  function buildPendingRow(info: CertificateBlockedInfo): HTMLElement {
    const matchingServer = servers.find((server) => server.origin === info.origin);

    const description = el('span', {
      text:
        `${info.origin} - SHA-256 ${info.certificateSha256Fingerprint} ` + `(${info.errorClass})`,
    });

    const approveButton = el('sp-button', { attrs: { variant: 'accent' }, text: 'Approve' });
    if (!matchingServer) approveButton.setAttribute('disabled', '');
    approveButton.addEventListener('click', () => {
      if (!matchingServer) return;
      approveButton.setAttribute('disabled', '');
      void window.daisy.browser
        .approveCertificateException({ serverId: matchingServer.id, exception: info })
        .then((result) => {
          if (result.ok) {
            pending = pending.filter((item) => item !== info);
            statusText.textContent = `Certificate exception approved for "${matchingServer.label}".`;
            renderPending();
            onExceptionChanged();
          } else {
            statusText.textContent = result.error.message;
            approveButton.removeAttribute('disabled');
          }
        });
    });

    const dismissButton = el('sp-button', { attrs: { variant: 'secondary' }, text: 'Dismiss' });
    dismissButton.addEventListener('click', () => {
      pending = pending.filter((item) => item !== info);
      renderPending();
    });

    const children = [description, approveButton, dismissButton];
    if (!matchingServer) {
      children.push(
        el('span', {
          attrs: { class: 'certificate-list__hint' },
          text: 'No configured server has this origin yet - add it in Settings first.',
        }),
      );
    }
    return el('li', { attrs: { class: 'certificate-list__item' }, children });
  }

  function renderPending(): void {
    pendingEmptyNotice.hidden = pending.length > 0;
    pendingList.replaceChildren(...pending.map(buildPendingRow));
  }

  function buildExceptionRow(server: ServerSnapshot): HTMLElement {
    const tlsException = server.tlsException;
    const removeButton = el('sp-button', { attrs: { variant: 'negative' }, text: 'Remove' });
    removeButton.addEventListener('click', () => {
      if (!tlsException) return;
      removeButton.setAttribute('disabled', '');
      void window.daisy.browser
        .revokeCertificateException({ serverId: server.id, origin: tlsException.origin })
        .then((result) => {
          if (result.ok) {
            statusText.textContent = `Certificate exception removed for "${server.label}".`;
            onExceptionChanged();
          } else {
            statusText.textContent = result.error.message;
            removeButton.removeAttribute('disabled');
          }
        });
    });
    return el('li', {
      attrs: { class: 'certificate-list__item' },
      children: [
        el('span', { text: `${server.label}: ${describeTlsException(tlsException)}` }),
        removeButton,
      ],
    });
  }

  const unsubscribe = window.daisy.browser.onCertificateBlocked((info) => {
    // A later block for the same origin replaces the earlier one - it is
    // the current state of that origin's certificate, not a second issue.
    pending = [...pending.filter((item) => item.origin !== info.origin), info];
    renderPending();
  });

  const element = el('section', {
    attrs: { class: 'settings-section', 'aria-label': 'Certificate exceptions' },
    children: [
      el('h2', { text: 'Certificate exceptions' }),
      statusText,
      el('h3', { text: 'Awaiting approval' }),
      pendingEmptyNotice,
      pendingList,
      emptyNotice,
      list,
    ],
  });

  renderPending();

  return {
    element,
    update(nextServers: readonly ServerSnapshot[]): void {
      servers = nextServers;
      const withExceptions = servers.filter((server) => server.tlsException);
      emptyNotice.hidden = withExceptions.length > 0;
      list.replaceChildren(...withExceptions.map(buildExceptionRow));
      // A newly-added server may now match a previously-unmatchable pending
      // block, so its "Approve" button needs to be re-enabled.
      renderPending();
    },
    dispose(): void {
      unsubscribe();
    },
  };
}
