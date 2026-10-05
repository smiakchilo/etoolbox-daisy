import { describe, expect, it } from 'vitest';
import { BANNER_ACTION_MARKER } from '../../../src/renderer/src/lib/alertBanner';
import {
  buildHostOptions,
  canOpenInExternalBrowser,
  computeAddressBarValue,
  computeReservedRegionBounds,
  deriveServerLabelFromOrigin,
  describeBlockedCertificate,
  describeUnknownOrigin,
  resolveAddressSwatchColor,
} from '../../../src/renderer/src/shell/viewModel';
import { newServerId, type ServerSnapshot } from '../../../src/shared';

const httpsServerId = newServerId(() => 'server-https');
const httpServerId = newServerId(() => 'server-http');

const httpsServer: ServerSnapshot = {
  id: httpsServerId,
  label: 'Production',
  origin: 'https://author.example',
  color: { kind: 'swatch', swatch: 'blue' },
  revision: 0,
};

const httpServer: ServerSnapshot = {
  id: httpServerId,
  label: 'Internal staging',
  origin: 'http://staging.internal',
  color: { kind: 'custom', hex: '#abcdef' },
  revision: 3,
};

const hosts: readonly ServerSnapshot[] = [httpsServer, httpServer];

describe('buildHostOptions', () => {
  it('maps every server to its id, label, origin and colour', () => {
    const options = buildHostOptions(hosts);
    expect(options).toEqual([
      {
        id: httpsServerId,
        label: 'Production',
        origin: 'https://author.example',
        colorCss: '#2680eb',
      },
      {
        id: httpServerId,
        label: 'Internal staging',
        origin: 'http://staging.internal',
        colorCss: '#abcdef',
      },
    ]);
  });

  it('returns an empty list for no configured servers', () => {
    expect(buildHostOptions([])).toEqual([]);
  });
});

describe('computeAddressBarValue', () => {
  it('is always empty: navigation is not wired yet, so it must never present a configured-but-unnavigated origin as the real current page', () => {
    expect(computeAddressBarValue()).toBe('');
  });
});

describe('resolveAddressSwatchColor', () => {
  const options = buildHostOptions(hosts);

  it('returns the matching host colour for a URL on a configured origin, ignoring path and query', () => {
    expect(resolveAddressSwatchColor('https://author.example/content/page.html?a=1', options)).toBe(
      '#2680eb',
    );
  });

  it('matches over the origin alone, so a different port or scheme does not match', () => {
    expect(resolveAddressSwatchColor('https://author.example:8443/', options)).toBeUndefined();
    expect(resolveAddressSwatchColor('http://author.example/', options)).toBeUndefined();
  });

  it('returns undefined for an empty or unparseable address so the CSS default shows', () => {
    expect(resolveAddressSwatchColor('', options)).toBeUndefined();
    expect(resolveAddressSwatchColor('not a url', options)).toBeUndefined();
  });

  it('returns undefined when no hosts are configured', () => {
    expect(resolveAddressSwatchColor('https://author.example/', [])).toBeUndefined();
  });
});

describe('canOpenInExternalBrowser', () => {
  it('accepts an absolute http(s) URL, path/query/fragment included', () => {
    expect(canOpenInExternalBrowser('https://author.example/content/page.html?a=1#s')).toBe(true);
    expect(canOpenInExternalBrowser('http://staging.internal:4502/')).toBe(true);
    // The very same predicate main re-validates with, so whitespace is trimmed.
    expect(canOpenInExternalBrowser('  https://author.example/  ')).toBe(true);
  });

  it('rejects an empty or scheme-less address', () => {
    expect(canOpenInExternalBrowser('')).toBe(false);
    expect(canOpenInExternalBrowser('   ')).toBe(false);
    expect(canOpenInExternalBrowser('author.example/content/page.html')).toBe(false);
  });

  it('rejects non-http(s) schemes and embedded credentials', () => {
    expect(canOpenInExternalBrowser('file:///C:/page.html')).toBe(false);
    expect(canOpenInExternalBrowser('javascript:alert(1)')).toBe(false);
    expect(canOpenInExternalBrowser('https://user:pass@author.example/')).toBe(false);
  });
});

describe('computeReservedRegionBounds', () => {
  it('rounds fractional coordinates to the nearest integer pixel', () => {
    expect(computeReservedRegionBounds({ x: 10.4, y: 20.6, width: 300.5, height: 400.49 })).toEqual(
      { x: 10, y: 21, width: 301, height: 400 },
    );
  });

  it('clamps a negative width/height to zero instead of reporting a negative size', () => {
    expect(computeReservedRegionBounds({ x: 0, y: 0, width: -5, height: -0.1 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('describeBlockedCertificate', () => {
  it('uses the fixed copy, mirroring the unknown-origin prompt (the address bar already shows the host)', () => {
    expect(describeBlockedCertificate()).toBe(
      `This host has an untrusted certificate. Press ${BANNER_ACTION_MARKER} to allow it`,
    );
  });
});

describe('describeUnknownOrigin', () => {
  it('uses fixed copy that never cites the origin - the address bar already shows it', () => {
    expect(describeUnknownOrigin()).toBe(
      `This host is unknown. Press ${BANNER_ACTION_MARKER} to add it to the managed hosts`,
    );
  });
});

describe('deriveServerLabelFromOrigin', () => {
  it('keeps the port so two local AEM instances stay distinguishable', () => {
    expect(deriveServerLabelFromOrigin('https://localhost:4502')).toBe('localhost:4502');
    expect(deriveServerLabelFromOrigin('https://localhost:4503')).toBe('localhost:4503');
  });

  it('omits the port when it is the scheme default', () => {
    expect(deriveServerLabelFromOrigin('https://author.example')).toBe('author.example');
  });
});
