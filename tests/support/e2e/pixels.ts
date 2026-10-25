import type { ElectronApplication } from '@playwright/test';

/**
 * A colour read back from the built app's own rendered pixels.
 *
 * Some of what this app promises is *paint order*, which no DOM assertion can
 * prove: a wash must land above a web component's shadow content, a veil must
 * land above a whole-size panel and fade the text on it. jsdom cannot see any
 * of it, and neither can `getComputedStyle` - a declaration can resolve while
 * another element's opaque background still covers it. Capturing the window's
 * real pixels is the only honest check.
 *
 * The capture runs in Electron's main process (`webContents.capturePage`), the
 * same channel every `app.evaluate` assertion uses. Every pixel of the box is
 * averaged so a glyph, a hairline border or a device scale factor cannot decide
 * the sample on its own; the darkest and lightest luminances are kept as well,
 * because "the text faded" is a question about the *extremes* - an average over
 * a mostly-empty line barely moves when its glyphs do.
 */

/** An RGB sample, 0-255 per channel: the box's mean plus its darkest/lightest pixel luminance. */
export interface PixelSample {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Luminance (0-255) of the darkest single pixel in the box. */
  readonly lumaMin: number;
  /** Luminance (0-255) of the lightest single pixel in the box. */
  readonly lumaMax: number;
}

/** A rectangle in CSS pixels, relative to the page's own origin (a locator's `boundingBox`). */
export interface SampleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Shrinks a box on every side, so a sample stays inside the element whose colour
 * it is meant to read: a bounding box is inclusive of borders and rounded
 * corners, and a neighbouring pixel is not evidence about this one.
 */
export function inset(box: SampleRect, by: number): SampleRect {
  return {
    x: box.x + by,
    y: box.y + by,
    width: Math.max(1, box.width - by * 2),
    height: Math.max(1, box.height - by * 2),
  };
}

/** Rec. 709 luminance of one BGRA pixel, 0-255. */
function luma(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * Samples the window's pixels inside `rect`. `capturePage`'s bitmap is BGRA; the
 * image's own size is whatever the window's scale factor makes it, which is why
 * the buffer is walked rather than indexed by an assumed width.
 */
export async function samplePixels(
  app: ElectronApplication,
  rect: SampleRect,
): Promise<PixelSample> {
  const bytes = await app.evaluate(async ({ BrowserWindow }, box: SampleRect) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error('no window to capture');
    const image = await window.webContents.capturePage(box);
    // `toBitmap` (not the deprecated `getBitmap`, whose declared return type is
    // `void` in Electron's typings) is the one typed as the raw pixel Buffer.
    return Array.from(image.toBitmap());
  }, rect);
  if (bytes.length === 0 || bytes.length % 4 !== 0) {
    throw new Error(`unexpected bitmap length ${String(bytes.length)}`);
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let lumaMin = Number.POSITIVE_INFINITY;
  let lumaMax = Number.NEGATIVE_INFINITY;
  const pixels = bytes.length / 4;
  for (let index = 0; index < bytes.length; index += 4) {
    // BGRA.
    const blue = bytes[index] ?? 0;
    const green = bytes[index + 1] ?? 0;
    const red = bytes[index + 2] ?? 0;
    r += red;
    g += green;
    b += blue;
    const value = luma(red, green, blue);
    if (value < lumaMin) lumaMin = value;
    if (value > lumaMax) lumaMax = value;
  }
  return {
    r: r / pixels,
    g: g / pixels,
    b: b / pixels,
    lumaMin,
    lumaMax,
  };
}

/** True when a sample is colourless (a gray or white surface, as the app's chrome is). */
export function isNeutral(sample: PixelSample, tolerance = 24): boolean {
  const channels = [sample.r, sample.g, sample.b];
  return Math.max(...channels) - Math.min(...channels) <= tolerance;
}

/** How much blue a sample carries over its red, the accent wash's own signature. */
export function blueOverRed(sample: PixelSample): number {
  return sample.b - sample.r;
}
