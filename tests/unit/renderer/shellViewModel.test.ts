import { describe, expect, it } from 'vitest';
import {
  buildServerOptions,
  computeAddressBarValue,
  computeInsecureMarker,
  computeReservedRegionBounds,
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

const servers: readonly ServerSnapshot[] = [httpsServer, httpServer];

describe('buildServerOptions', () => {
  it('maps every server, marking the active one as selected', () => {
    const options = buildServerOptions(servers, httpServerId);
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
    const options = buildServerOptions(servers, null);
    expect(options.every((option) => !option.selected)).toBe(true);
  });

  it('returns an empty list for no configured servers', () => {
    expect(buildServerOptions([], null)).toEqual([]);
  });
});

describe('computeInsecureMarker', () => {
  it('is hidden when no server is active', () => {
    expect(computeInsecureMarker(servers, null)).toEqual({ visible: false, message: '' });
  });

  it('is hidden when the active server is HTTPS', () => {
    expect(computeInsecureMarker(servers, httpsServerId)).toEqual({
      visible: false,
      message: '',
    });
  });

  it('is visible with a message naming the server when the active server is plain HTTP', () => {
    const state = computeInsecureMarker(servers, httpServerId);
    expect(state.visible).toBe(true);
    expect(state.message).toContain('Internal staging');
    expect(state.message).toContain('http://staging.internal');
  });

  it('is hidden when the active server id does not match any configured server', () => {
    const danglingId = newServerId(() => 'server-deleted');
    expect(computeInsecureMarker(servers, danglingId)).toEqual({ visible: false, message: '' });
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
