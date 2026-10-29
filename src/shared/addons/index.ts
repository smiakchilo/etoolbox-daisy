export * from './addonHost';
export * from './contribution';

/**
 * The pins are deliberately **not** re-exported here. `pins.ts` reads the
 * generated `pins.json`, and an add-on imports this folder's barrel for the
 * `AddonHost`/`AddonModule` contract: re-exporting the pins would pull that JSON
 * into every add-on's own bundle, which (a) needs the file to exist before the
 * script that generates it has written it, and (b) hashes the generated file
 * into the add-on's content identity - so the identity would change on every
 * build. Anything that wants the pins imports `src/shared/addons/pins` itself
 * (`tests/unit/addons/buildDerivation.test.ts` guards this).
 */
