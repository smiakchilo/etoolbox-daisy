import { describe, expect, it } from 'vitest';
import {
  buildHostOptions,
  computeAddressBarValue,
  computeReservedRegionBounds,
  deriveServerLabelFromOrigin,
  describeBlockedCertificate,
  describeUnknownOrigin,
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
  it('maps every server, marking the active one as selected', () => {
    const options = buildHostOptions(hosts, httpServerId);
    expect(options).toEqual([
      {
        id: httpsServerId,
        label: 'Production',
        origin: 'https://author.example',
        colorCss: '#2680eb',
        selected: false,
      },
      {
        id: httpServerId,
        label: 'Internal staging',
        origin: 'http://staging.internal',
        colorCss: '#abcdef',
        selected: true,
      },
    ]);
  });

  it('marks nothing selected when there is no active server', () => {
    const options = buildHostOptions(hosts, null);
    expect(options.every((option) => !option.selected)).toBe(true);
  });

  it('returns an empty list for no configured servers', () => {
    expect(buildHostOptions([], null)).toEqual([]);
  });
});

describe('computeAddressBarValue', () => {
  it('is always empty: navigation is not wired yet, so it must never present a configured-but-unnavigated origin as the real current page', () => {
    expect(computeAddressBarValue()).toBe('');
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
      'This host has an untrusted certificate. Press OK to allow it',
    );
  });
});

describe('describeUnknownOrigin', () => {
  it('uses fixed copy that never cites the origin - the address bar already shows it', () => {
    expect(describeUnknownOrigin()).toBe(
      'This host is unknown. Press OK to add it to the managed hosts',
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
