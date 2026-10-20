import { describe, expect, it } from 'vitest';
import { BANNER_ACTION_MARKER } from '../../../src/renderer/src/lib/alertBanner';
import {
  type HostOption,
  buildHostOptions,
  canOpenInExternalBrowser,
  computeAddressBarValue,
  computeReservedRegionBounds,
  deriveServerLabelFromOrigin,
  describeBlockedCertificate,
  describeUnknownOrigin,
  findHostAutocomplete,
  resolveAddressChipHost,
  resolveAddressHost,
  resolveAddressSubmission,
  resolveEditModeTarget,
  resolveHostLabelForeground,
  shouldInferAddressCompletion,
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

describe('resolveAddressHost', () => {
  const options = buildHostOptions(hosts);

  it('returns the matching host for a URL on a configured origin, ignoring path and query', () => {
    expect(resolveAddressHost('https://author.example/content/page.html?a=1', options)).toEqual(
      options[0],
    );
  });

  it('matches over the origin alone, so a different port or scheme does not match', () => {
    expect(resolveAddressHost('https://author.example:8443/', options)).toBeUndefined();
    expect(resolveAddressHost('http://author.example/', options)).toBeUndefined();
  });

  it('returns undefined for an empty or unparseable address', () => {
    expect(resolveAddressHost('', options)).toBeUndefined();
    expect(resolveAddressHost('not a url', options)).toBeUndefined();
  });

  it('returns undefined when no hosts are configured', () => {
    expect(resolveAddressHost('https://author.example/', [])).toBeUndefined();
  });
});

describe('resolveAddressChipHost', () => {
  const options = buildHostOptions(hosts);

  it('matches an exact origin like resolveAddressHost, including paths', () => {
    expect(resolveAddressChipHost('https://author.example/content/page.html', options)).toEqual(
      options[0],
    );
    expect(resolveAddressChipHost('https://author.example', options)).toEqual(options[0]);
  });

  it('keeps a host matched while its origin is only partially typed', () => {
    // The Backspace walk out of the loaded URL: each of these is a prefix of
    // the origin, so the chip stays rather than blinking off and on.
    for (const partial of ['h', 'http', 'https://auth', 'HTTPS://AUTH']) {
      expect(resolveAddressChipHost(partial, options)).toEqual(options[0]);
    }
    // A deeper prefix still matches the same (first-in-list) origin.
    expect(resolveAddressChipHost('https://author.exampl', options)).toEqual(options[0]);
  });

  it('keeps a host matched while its host[:port] is only partially typed', () => {
    expect(resolveAddressChipHost('stagin', options)).toEqual(options[1]);
    expect(resolveAddressChipHost('staging.internal', options)).toEqual(options[1]);
  });

  it('drops the match as soon as the value can no longer be that host', () => {
    // A different port is not a prefix of the origin and matches nothing.
    expect(resolveAddressChipHost('https://author.example:8443', options)).toBeUndefined();
    expect(resolveAddressChipHost('https://other.example', options)).toBeUndefined();
    // A middle edit that breaks the prefix.
    expect(resolveAddressChipHost('https://auhor.example', options)).toBeUndefined();
  });

  it('does not match a value that only starts with a host label', () => {
    // The label completion shows "label + URL" and the chip stays hidden then.
    expect(resolveAddressChipHost('Production', options)).toBeUndefined();
    expect(resolveAddressChipHost('prod', options)).toBeUndefined();
    expect(resolveAddressChipHost('Production https://author.example', options)).toBeUndefined();
  });

  it('returns undefined for an empty value or no hosts', () => {
    expect(resolveAddressChipHost('', options)).toBeUndefined();
    expect(resolveAddressChipHost('   ', options)).toBeUndefined();
    expect(resolveAddressChipHost('https://auth', [])).toBeUndefined();
  });

  it('resolves an origin-prefix match in host-list order, like the type-ahead', () => {
    const twoOrigins: readonly HostOption[] = [
      { id: httpsServerId, label: 'One', origin: 'https://author.example', colorCss: '#2680eb' },
      { id: httpServerId, label: 'Two', origin: 'https://author.other', colorCss: '#abcdef' },
    ];
    expect(resolveAddressChipHost('https://author', twoOrigins)).toEqual(twoOrigins[0]);
  });
});

describe('resolveHostLabelForeground', () => {
  it('keeps white text on the dark and mid-tone swatches', () => {
    // Spectrum 600-scale chromatic values: blue, green, red.
    expect(resolveHostLabelForeground('#2680eb')).toBe('#ffffff');
    expect(resolveHostLabelForeground('#2d9d78')).toBe('#ffffff');
    expect(resolveHostLabelForeground('#e34850')).toBe('#ffffff');
  });

  it('switches to dark gray once white would lose too much contrast', () => {
    // The bright yellow and orange swatches, and a near-white custom colour.
    expect(resolveHostLabelForeground('#dfbf00')).toBe('#2e2e2e');
    expect(resolveHostLabelForeground('#e68619')).toBe('#2e2e2e');
    expect(resolveHostLabelForeground('#fefefe')).toBe('#2e2e2e');
  });

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(resolveHostLabelForeground('  #DFBF00 ')).toBe('#2e2e2e');
  });

  it('falls back to white for an unparseable colour', () => {
    expect(resolveHostLabelForeground('not a colour')).toBe('#ffffff');
    expect(resolveHostLabelForeground('#abc')).toBe('#ffffff');
  });
});

describe('findHostAutocomplete', () => {
  const options = buildHostOptions(hosts);

  it('completes a typed origin prefix and selects only the appended remainder', () => {
    expect(findHostAutocomplete('https://auth', options)).toEqual({
      value: 'https://author.example',
      selectionStart: 'https://auth'.length,
      selectionEnd: 'https://author.example'.length,
    });
  });

  it('completes a typed label prefix to "label + URL", selecting only the text after the typed prefix', () => {
    const value = 'Production https://author.example';
    expect(findHostAutocomplete('Prod', options)).toEqual({
      value,
      selectionStart: 'Prod'.length,
      selectionEnd: value.length,
    });
  });

  it('never selects the whole value for a label, even when the whole label is typed', () => {
    const value = 'Production https://author.example';
    const completion = findHostAutocomplete('Production', options);
    expect(completion).toEqual({
      value,
      selectionStart: 'Production'.length,
      selectionEnd: value.length,
    });
    expect(completion?.selectionStart).toBeGreaterThan(0);
  });

  it('completes a typed domain prefix, inserting the protocol before it', () => {
    // "auth" -> "https://auth[or.example]": the protocol is prepended and the
    // rest of the host after the typed part is selected.
    expect(findHostAutocomplete('auth', options)).toEqual({
      value: 'https://author.example',
      selectionStart: 'https://'.length + 'auth'.length,
      selectionEnd: 'https://author.example'.length,
    });
    // A second, http host keeps its own protocol.
    expect(findHostAutocomplete('staging', options)).toEqual({
      value: 'http://staging.internal',
      selectionStart: 'http://'.length + 'staging'.length,
      selectionEnd: 'http://staging.internal'.length,
    });
  });

  it('prefers a full-origin match over a domain match', () => {
    // "https://auth" is a prefix of the origin, so it keeps its typed prefix
    // rather than being treated as a domain.
    expect(findHostAutocomplete('https://auth', options)).toEqual({
      value: 'https://author.example',
      selectionStart: 'https://auth'.length,
      selectionEnd: 'https://author.example'.length,
    });
  });

  it('prefers an origin match over a label match', () => {
    // "Internal staging" is the second host's label; "http://staging.internal"
    // its origin. Typing "http" matches the origin first.
    expect(findHostAutocomplete('http', options)?.value).toBe('https://author.example');
  });

  it('offers nothing for an exact origin, a non-prefix, blank input, or no hosts', () => {
    expect(findHostAutocomplete('https://author.example', options)).toBeUndefined();
    expect(findHostAutocomplete('nope', options)).toBeUndefined();
    expect(findHostAutocomplete('   ', options)).toBeUndefined();
    expect(findHostAutocomplete('https://auth', [])).toBeUndefined();
  });

  it('is case-insensitive over both the address and the label', () => {
    expect(findHostAutocomplete('HTTPS://AUTH', options)?.value).toBe('https://author.example');
    expect(findHostAutocomplete('prod', options)?.value).toBe('Production https://author.example');
  });
});

describe('shouldInferAddressCompletion', () => {
  it('infers for textual insertions', () => {
    expect(shouldInferAddressCompletion('insertText')).toBe(true);
    expect(shouldInferAddressCompletion('insertFromPaste')).toBe(true);
    expect(shouldInferAddressCompletion('insertFromDrop')).toBe(true);
    expect(shouldInferAddressCompletion('insertReplacementText')).toBe(true);
  });

  it('never infers for a deletion, so Backspace/Delete are not immediately undone', () => {
    expect(shouldInferAddressCompletion('deleteContentBackward')).toBe(false);
    expect(shouldInferAddressCompletion('deleteContentForward')).toBe(false);
    expect(shouldInferAddressCompletion('deleteWordBackward')).toBe(false);
    expect(shouldInferAddressCompletion('deleteWordForward')).toBe(false);
    expect(shouldInferAddressCompletion('deleteSoftLineBackward')).toBe(false);
    expect(shouldInferAddressCompletion('deleteHardLineForward')).toBe(false);
    expect(shouldInferAddressCompletion('deleteByCut')).toBe(false);
    expect(shouldInferAddressCompletion('deleteByDrag')).toBe(false);
  });

  it('never infers for undo/redo, which the completion would immediately undo', () => {
    expect(shouldInferAddressCompletion('historyUndo')).toBe(false);
    expect(shouldInferAddressCompletion('historyRedo')).toBe(false);
  });

  it('never infers during IME composition', () => {
    expect(shouldInferAddressCompletion('insertCompositionText', true)).toBe(false);
    expect(shouldInferAddressCompletion('insertText', true)).toBe(false);
  });

  it('treats an absent inputType (a bare synthetic Event) as an insertion', () => {
    expect(shouldInferAddressCompletion(undefined)).toBe(true);
  });
});

describe('resolveAddressSubmission', () => {
  const options = buildHostOptions(hosts);

  it('leaves an absolute http(s) URL as typed, path/query included', () => {
    expect(resolveAddressSubmission('https://author.example/editor.html?a=1', options)).toBe(
      'https://author.example/editor.html?a=1',
    );
  });

  it('adds the configured host protocol to a scheme-less domain', () => {
    expect(resolveAddressSubmission('author.example', options)).toBe('https://author.example');
    expect(resolveAddressSubmission('author.example/editor.html', options)).toBe(
      'https://author.example/editor.html',
    );
    expect(resolveAddressSubmission('staging.internal/x?y=1#z', options)).toBe(
      'http://staging.internal/x?y=1#z',
    );
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(resolveAddressSubmission('  AUTHOR.EXAMPLE/p  ', options)).toBe(
      'https://author.example/p',
    );
  });

  it('strips a configured label prefix from a combined "label + URL" value', () => {
    expect(resolveAddressSubmission('Production https://author.example/editor.html', options)).toBe(
      'https://author.example/editor.html',
    );
    // The remainder may itself be scheme-less.
    expect(resolveAddressSubmission('Production author.example/x', options)).toBe(
      'https://author.example/x',
    );
    // Case-insensitive label, and a label containing spaces.
    expect(resolveAddressSubmission('internal staging http://staging.internal/y', options)).toBe(
      'http://staging.internal/y',
    );
  });

  it('does not strip a label when what follows is not navigable', () => {
    expect(resolveAddressSubmission('Production nonsense', options)).toBe('Production nonsense');
    // A label with nothing after it is not a combined value.
    expect(resolveAddressSubmission('Production', options)).toBe('Production');
    expect(resolveAddressSubmission('Production ', options)).toBe('Production');
  });

  it('leaves an unknown host or non-http scheme unchanged, so main still refuses it', () => {
    expect(resolveAddressSubmission('unknown.example/x', options)).toBe('unknown.example/x');
    expect(resolveAddressSubmission('ftp://author.example', options)).toBe('ftp://author.example');
    expect(resolveAddressSubmission('', options)).toBe('');
    expect(resolveAddressSubmission('   ', options)).toBe('');
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

describe('resolveEditModeTarget', () => {
  it('offers the editor URL for a /content .html page in the web-content view', () => {
    expect(resolveEditModeTarget('https://author.example/content/site/page.html')).toEqual({
      enabled: true,
      editing: false,
      toggledUrl: 'https://author.example/editor.html/content/site/page.html',
      webContentViewUrl: 'https://author.example/content/site/page.html?wcmmode=disabled',
    });
  });

  it('offers the web-content visitor view for a page already open in the editor', () => {
    expect(
      resolveEditModeTarget('https://author.example/editor.html/content/site/page.html'),
    ).toEqual({
      enabled: true,
      editing: true,
      toggledUrl: 'https://author.example/content/site/page.html?wcmmode=disabled',
      webContentViewUrl: 'https://author.example/content/site/page.html?wcmmode=disabled',
    });
  });

  it('keeps the origin, other query params and fragment across the switch', () => {
    expect(
      resolveEditModeTarget('http://staging.internal:4502/content/site/page.html?a=1#frag')
        ?.toggledUrl,
    ).toBe('http://staging.internal:4502/editor.html/content/site/page.html?a=1#frag');
    expect(
      resolveEditModeTarget(
        'http://staging.internal:4502/editor.html/content/site/page.html?a=1#frag',
      )?.toggledUrl,
    ).toBe('http://staging.internal:4502/content/site/page.html?a=1&wcmmode=disabled#frag');
  });

  it('offers the web-content visitor view from the web-content view too', () => {
    // The long press asks for `wcmmode=disabled` whatever the current state is,
    // so this URL must not depend on which rendering is open now.
    expect(
      resolveEditModeTarget('https://author.example/content/site/page.html?a=1#frag')
        .webContentViewUrl,
    ).toBe('https://author.example/content/site/page.html?a=1&wcmmode=disabled#frag');
    expect(
      resolveEditModeTarget('https://author.example/editor.html/content/site/page.html?a=1#frag')
        .webContentViewUrl,
    ).toBe('https://author.example/content/site/page.html?a=1&wcmmode=disabled#frag');
  });

  it('replaces any other wcmmode with wcmmode=disabled for the visitor view', () => {
    expect(
      resolveEditModeTarget('https://author.example/content/site/page.html?wcmmode=edit')
        .webContentViewUrl,
    ).toBe('https://author.example/content/site/page.html?wcmmode=disabled');
  });

  it('sets wcmmode=disabled when untoggling, replacing any other wcmmode', () => {
    expect(
      resolveEditModeTarget(
        'https://author.example/editor.html/content/site/page.html?wcmmode=edit',
      )?.toggledUrl,
    ).toBe('https://author.example/content/site/page.html?wcmmode=disabled');
  });

  it('removes wcmmode when toggling into the editor', () => {
    expect(
      resolveEditModeTarget('https://author.example/content/site/page.html?wcmmode=disabled')
        ?.toggledUrl,
    ).toBe('https://author.example/editor.html/content/site/page.html');
    // A different wcmmode value is dropped too - the editor implies authoring.
    expect(
      resolveEditModeTarget('https://author.example/content/site/page.html?wcmmode=edit&a=1')
        ?.toggledUrl,
    ).toBe('https://author.example/editor.html/content/site/page.html?a=1');
  });

  it('disables the control for a DAM asset, even a .html one', () => {
    expect(resolveEditModeTarget('https://author.example/content/dam/site/page.html').enabled).toBe(
      false,
    );
  });

  it('disables the control for a non-.html resource', () => {
    expect(resolveEditModeTarget('https://author.example/content/dam/a.jpg').enabled).toBe(false);
    expect(resolveEditModeTarget('https://author.example/content/site/page.json').enabled).toBe(
      false,
    );
    expect(resolveEditModeTarget('https://author.example/content/site/page').enabled).toBe(false);
  });

  it('disables the control outside /content', () => {
    expect(
      resolveEditModeTarget('https://author.example/libs/granite/core/page.html').enabled,
    ).toBe(false);
    expect(resolveEditModeTarget('https://author.example/apps/site/page.html').enabled).toBe(false);
  });

  it('disables the control when the editor wraps a non-/content path', () => {
    expect(resolveEditModeTarget('https://author.example/editor.html/libs/x.html').enabled).toBe(
      false,
    );
  });

  it('recognises the editor prefix only at the start of the pathname', () => {
    // A page merely named .../editor.html/... is still a content page, not the
    // editor, so the toggle stays off.
    const target = resolveEditModeTarget('https://author.example/content/editor.html/page.html');
    expect(target.enabled).toBe(true);
    expect(target.editing).toBe(false);
  });

  it('recognises the editor behind the Cloud Service shell route in the fragment', () => {
    // AEM as a Cloud Service serves the editor as `<origin>/ui#/aem/editor.html/...`:
    // the wrapper sits in the fragment, not at the start of the pathname.
    expect(
      resolveEditModeTarget('https://author.example/ui#/aem/editor.html/content/site/page.html'),
    ).toEqual({
      enabled: true,
      editing: true,
      toggledUrl: 'https://author.example/content/site/page.html?wcmmode=disabled',
      webContentViewUrl: 'https://author.example/content/site/page.html?wcmmode=disabled',
    });
  });

  it('untogling a shell editor leaves the shell - its route fragment and shell query are dropped', () => {
    expect(
      resolveEditModeTarget(
        'https://author.example/ui#/aem/editor.html/content/site/page.html?appId=aemshell',
      )?.toggledUrl,
    ).toBe('https://author.example/content/site/page.html?wcmmode=disabled');
    expect(
      resolveEditModeTarget(
        'https://author.example/ui?appId=aemshell#/aem/editor.html/content/site/page.html',
      )?.toggledUrl,
    ).toBe('https://author.example/content/site/page.html?wcmmode=disabled');
  });

  it('does not treat a shell console route as the editor', () => {
    expect(
      resolveEditModeTarget('https://author.example/ui#/aem/sites.html/content/site/page.html')
        .enabled,
    ).toBe(false);
    expect(
      resolveEditModeTarget('https://author.example/ui#/aem/editor.html/libs/x.html').enabled,
    ).toBe(false);
  });

  it('disables the control for a non-http(s) URL, an unparseable value, or no URL at all', () => {
    expect(resolveEditModeTarget('file:///content/page.html').enabled).toBe(false);
    expect(resolveEditModeTarget('javascript:alert(1)').enabled).toBe(false);
    expect(resolveEditModeTarget('not a url').enabled).toBe(false);
    expect(resolveEditModeTarget('').enabled).toBe(false);
    // A disabled control offers no navigation of either kind.
    expect(resolveEditModeTarget('').webContentViewUrl).toBeUndefined();
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
      `Untrusted certificate. Press ${BANNER_ACTION_MARKER} to allow`,
    );
  });
});

describe('describeUnknownOrigin', () => {
  it('uses fixed copy that never cites the origin - the address bar already shows it', () => {
    expect(describeUnknownOrigin()).toBe(`Unknown host. Press ${BANNER_ACTION_MARKER} to add it`);
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
