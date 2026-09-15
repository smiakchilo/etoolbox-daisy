/// <reference types="vite/client" />

import type { DaisyAppApi } from '../../shared';

export {};

declare global {
  interface Window {
    readonly daisy: DaisyAppApi;
  }
}
