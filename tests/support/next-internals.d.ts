// Types for the Next.js internal used by tests/unit/proxy-session.test.ts to compile `config.matcher`
// exactly as Next does. Test-only; production code never imports Next internals.
declare module 'next/dist/compiled/path-to-regexp/index.js' {
  export function pathToRegexp(source: string, keys: unknown[], options: Record<string, unknown>): RegExp;
}
