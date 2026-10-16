import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Migrated PGlite template built by tests/support/global-setup.ts for this test run. */
    pgliteTemplatePath: string;
  }
}
