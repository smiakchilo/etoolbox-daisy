/**
 * Generates the platform icon files from the single source of truth.
 *
 * `resources/icon.png` is the only committed icon. This script derives
 * `resources/icon.ico` (Windows: window/taskbar icon, and electron-builder's
 * `win.icon`) and `resources/icon.icns` (macOS: electron-builder's `mac.icon`)
 * from it, so both are recreated on every build and can never drift from the
 * PNG. Run by `npm run icons`, which `build`/`dev`/`package:*` invoke first.
 *
 * Both outputs are git-ignored. `png2icons` is a dependency-free, pure-JS
 * converter (no native binaries).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import png2icons from 'png2icons';

const resources = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources');
const source = join(resources, 'icon.png');

const png = readFileSync(source);
const ico = png2icons.createICO(png, png2icons.BICUBIC, 0, false);
const icns = png2icons.createICNS(png, png2icons.BICUBIC, 0);
if (ico === null || icns === null) {
  throw new Error('Could not derive icon.ico/icon.icns from resources/icon.png');
}
writeFileSync(join(resources, 'icon.ico'), ico);
writeFileSync(join(resources, 'icon.icns'), icns);
console.log(
  `Generated resources/icon.ico (${String(ico.length)} B) and ` +
    `resources/icon.icns (${String(icns.length)} B) from resources/icon.png`,
);
