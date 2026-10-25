// Intentional rule-violation fixture. Do NOT fix this file - it exists only
// to prove the add-on boundary rules (eslint.config.mjs) actually fire:
//  - an add-on folder may not import the application (`../../main/...`);
//  - an add-on may not import Electron at run time, only its types.
// It is excluded from `eslint .` and must be linted directly with
// `npx eslint --no-ignore tests/fixtures/eslint-violations/addon-boundary-violation.ts`
// (expect exactly two errors).
import { app } from 'electron';
import { createLogger } from '../../main/logger';

export const forbidden = [createLogger, app];
