import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Architecture fitness functions, checked statically on the source tree (CLAUDE.md, ARCHITECTURE.md and the
 * implementation conventions):
 *
 * - provider boundaries: the OpenAI SDK only inside its adapters, the adapters only behind the provider
 *   factory, model names only in configuration;
 * - layering: server code never depends on routes/UI; the domain and agent core are channel-neutral and never
 *   reach for the composition root; public API routes go through the channel service; `src/shared` is isomorphic;
 * - the browser bundle: nothing reachable from client code is server code or a server-only package, and client
 *   code reads no environment variable except NODE_ENV; server entry modules are guarded by `server-only`;
 * - database: every migrated table keeps RLS enabled, policies and grants only ever name `authenticated`,
 *   SECURITY DEFINER functions pin their search_path and stay in the unexposed app_private schema, and SQL
 *   selects explicit columns.
 *
 * Files are parsed with the TypeScript compiler, so type-only, re-exported, dynamic (`import()`), `require` and
 * `import('x').T` references all count. Each rule is also run against synthetic violations, so a scanner that
 * silently finds nothing cannot pass.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// ── source model ──────────────────────────────────────────────────────────────

interface ImportRef {
  specifier: string;
  line: number;
  /** Repository file for `@/…` and relative imports, else null. */
  target: string | null;
  /** Package (or node builtin) for bare specifiers, else null. */
  pkg: string | null;
}

interface SourceModule {
  /** Repository-relative POSIX path, e.g. 'src/server/db/sql.ts'. */
  file: string;
  imports: ImportRef[];
  /** String, template, regular expression and JSX text literals. */
  literals: Array<{ text: string; line: number }>;
  /** Every `process.env` access; only `process.env.NODE_ENV` is `allowed` in client code. */
  envReads: Array<{ line: number; allowed: boolean }>;
  useClient: boolean;
}

type Modules = ReadonlyMap<string, SourceModule>;

/** Repository-relative POSIX paths of every file under `dir`. */
function listFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk(dir);
  return files.sort();
}

const isCode = (file: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file);
const inDir = (file: string, dir: string) => file.startsWith(`${dir}/`);
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function resolveImport(from: string, specifier: string, line: number, knownFiles: ReadonlySet<string>): ImportRef {
  let base: string | null = null;
  if (specifier.startsWith('@/')) base = `src/${specifier.slice(2)}`;
  else if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) {
    base = path.posix.join(path.posix.dirname(from), specifier);
  }
  if (base === null) return { specifier, line, target: null, pkg: packageName(specifier) };
  const resolvedBase = base;
  const target = RESOLVE_SUFFIXES.map((suffix) => `${resolvedBase}${suffix}`).find((file) => knownFiles.has(file));
  // An unresolvable internal import means the scanner would miss an edge: fail loudly instead.
  if (target === undefined) throw new Error(`${from}:${line} imports "${specifier}", which resolves to no file under src/`);
  return { specifier, line, target, pkg: null };
}

function isProcessEnv(node: ts.Node): boolean {
  const isProcess = (expression: ts.Expression) =>
    (ts.isIdentifier(expression) && expression.text === 'process') ||
    (ts.isPropertyAccessExpression(expression) && expression.name.text === 'process');
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'env' && isProcess(node.expression);
  if (ts.isElementAccessExpression(node)) {
    return ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'env' && isProcess(node.expression);
  }
  return false;
}

function hasDirective(source: ts.SourceFile, directive: string): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === directive) return true;
  }
  return false;
}

function parseModule(file: string, text: string, knownFiles: ReadonlySet<string>): SourceModule {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const unit: SourceModule = { file, imports: [], literals: [], envReads: [], useClient: hasDirective(source, 'use client') };
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const addImport = (node: ts.Node, specifier: ts.Node | undefined) => {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      unit.imports.push(resolveImport(file, specifier.text, lineOf(node), knownFiles));
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addImport(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addImport(node, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      addImport(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addImport(node, node.argument.literal);
    }

    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isJsxText(node)
    ) {
      unit.literals.push({ text: node.text, line: lineOf(node) });
    }
    if (isProcessEnv(node)) {
      const parent = node.parent;
      const allowed = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'NODE_ENV';
      unit.envReads.push({ line: lineOf(node), allowed });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return unit;
}

const SRC_FILES = listFiles('src');
const KNOWN_FILES: ReadonlySet<string> = new Set(SRC_FILES);
const MODULES: Modules = new Map(
  SRC_FILES.filter(isCode).map((file) => [file, parseModule(file, readFileSync(path.join(ROOT, file), 'utf8'), KNOWN_FILES)]),
);

// ── rules (each returns its violations as "file:line …" strings) ─────────────────

function importViolations(modules: Modules, isViolation: (unit: SourceModule, ref: ImportRef) => boolean): string[] {
  const violations: string[] = [];
  for (const unit of modules.values()) {
    for (const ref of unit.imports) {
      if (isViolation(unit, ref)) violations.push(`${unit.file}:${ref.line} imports "${ref.specifier}"`);
    }
  }
  return violations;
}

const targetIn = (ref: ImportRef, ...dirs: string[]) => ref.target !== null && dirs.some((dir) => inDir(ref.target ?? '', dir));

/** CLAUDE.md 18 / ARCHITECTURE.md 4: provider SDK types never leave the adapter. */
const openAiSdkOutsideAdapter = (modules: Modules) =>
  importViolations(modules, (unit, ref) => ref.pkg === 'openai' && !inDir(unit.file, 'src/server/ai/openai'));

const PROVIDER_FACTORY = 'src/server/ai/providers.ts';
const COMPOSITION_ROOTS = ['src/server/services.ts', 'src/server/app-services.ts'];

/** The adapters are wired only by the provider factory, and the factory only by the app's composition root. */
const adapterWiring = (modules: Modules) =>
  importViolations(
    modules,
    (unit, ref) =>
      (targetIn(ref, 'src/server/ai/openai') && !inDir(unit.file, 'src/server/ai/openai') && unit.file !== PROVIDER_FACTORY) ||
      (ref.target === PROVIDER_FACTORY && unit.file !== 'src/server/app-services.ts'),
  );

const MODEL_NAME = /gpt-|text-embedding-/i;

/** CLAUDE.md: model names live in configuration/env only. */
function modelNamesOutsideConfig(modules: Modules): string[] {
  const violations: string[] = [];
  for (const unit of modules.values()) {
    if (inDir(unit.file, 'src/server/config')) continue;
    for (const literal of unit.literals) {
      if (MODEL_NAME.test(literal.text)) violations.push(`${unit.file}:${literal.line} "${literal.text.slice(0, 80)}"`);
    }
  }
  return violations;
}

const serverImportsUi = (modules: Modules) =>
  importViolations(modules, (unit, ref) => inDir(unit.file, 'src/server') && targetIn(ref, 'src/app', 'src/components', 'src/widget'));

/** CLAUDE.md 10: chat, voice and phone reuse one channel-neutral core. */
const coreImportsChannels = (modules: Modules) =>
  importViolations(
    modules,
    (unit, ref) =>
      (inDir(unit.file, 'src/server/domain') || inDir(unit.file, 'src/server/agent')) && targetIn(ref, 'src/server/channels'),
  );

/** Dependencies are injected: business code never reaches for the process-wide services. */
const businessCodeImportsCompositionRoot = (modules: Modules) =>
  importViolations(
    modules,
    (unit, ref) =>
      ['src/server/domain', 'src/server/agent', 'src/server/channels', 'src/server/ai', 'src/server/db'].some((dir) =>
        inDir(unit.file, dir),
      ) &&
      ref.target !== null &&
      COMPOSITION_ROOTS.includes(ref.target),
  );

/** The public widget API is thin: tenant resolution, tools and data access stay behind the web chat service. */
const apiRoutesBypassChannel = (modules: Modules) =>
  importViolations(
    modules,
    (unit, ref) =>
      inDir(unit.file, 'src/app/api') && targetIn(ref, 'src/server/db', 'src/server/domain', 'src/server/agent', 'src/server/ai'),
  );

const SERVER_ONLY_PACKAGES = new Set(['server-only', 'pg', 'openai', '@electric-sql/pglite', '@electric-sql/pglite-pgvector']);
const SERVER_ONLY_SPECIFIERS = new Set(['next/headers']);

function isServerOnlyImport(ref: ImportRef): boolean {
  if (ref.pkg === null) return false;
  return (
    SERVER_ONLY_PACKAGES.has(ref.pkg) ||
    SERVER_ONLY_SPECIFIERS.has(ref.specifier) ||
    ref.pkg.startsWith('node:') ||
    builtinModules.includes(ref.pkg)
  );
}

/** `src/shared` is imported by the browser and the server alike. */
const sharedNotIsomorphic = (modules: Modules) =>
  importViolations(
    modules,
    (unit, ref) =>
      inDir(unit.file, 'src/shared') && ((ref.target !== null && !inDir(ref.target, 'src/shared')) || isServerOnlyImport(ref)),
  );

const isClientRoot = (unit: SourceModule) =>
  unit.useClient || ['src/widget', 'src/components', 'src/shared'].some((dir) => inDir(unit.file, dir));

/** Everything that can end up in the browser bundle, with the import chain that reaches it. */
function clientClosure(modules: Modules): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  const queue: string[] = [];
  for (const unit of modules.values()) {
    if (isClientRoot(unit)) {
      chains.set(unit.file, [unit.file]);
      queue.push(unit.file);
    }
  }
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const chain = chains.get(file) ?? [file];
    for (const ref of modules.get(file)?.imports ?? []) {
      if (ref.target === null || chains.has(ref.target) || !modules.has(ref.target)) continue;
      chains.set(ref.target, [...chain, ref.target]);
      queue.push(ref.target);
    }
  }
  return chains;
}

/** No server code, secrets or server-only packages in the browser bundle (transitively). */
function clientReachesServer(modules: Modules): string[] {
  const violations: string[] = [];
  for (const [file, chain] of clientClosure(modules)) {
    if (inDir(file, 'src/server')) violations.push(`client code reaches ${file} via ${chain.join(' -> ')}`);
    for (const ref of modules.get(file)?.imports ?? []) {
      if (isServerOnlyImport(ref)) violations.push(`client code ${chain.join(' -> ')} imports "${ref.specifier}"`);
    }
  }
  return violations;
}

/** Next.js inlines only NEXT_PUBLIC_* in client bundles; anything else is a leak or undefined. NODE_ENV is fine. */
function clientEnvReads(modules: Modules): string[] {
  const violations: string[] = [];
  for (const file of clientClosure(modules).keys()) {
    for (const read of modules.get(file)?.envReads ?? []) {
      if (!read.allowed) violations.push(`${file}:${read.line} reads process.env`);
    }
  }
  return violations;
}

const SERVER_ENTRY_MODULES = ['src/server/config/env.ts', 'src/server/db/client.ts', PROVIDER_FACTORY, ...COMPOSITION_ROOTS];

/** Modules holding secrets, provider clients or the composition root must fail the build if bundled for the browser. */
function unguardedServerEntries(modules: Modules): string[] {
  const violations: string[] = [];
  for (const unit of modules.values()) {
    const mustGuard =
      SERVER_ENTRY_MODULES.includes(unit.file) ||
      inDir(unit.file, 'src/server/ai/openai') ||
      inDir(unit.file, 'src/server/auth') ||
      unit.imports.some((ref) => ref.pkg === 'openai') ||
      // Environment reads in client code are a different violation (clientEnvReads), not a missing guard.
      (!isClientRoot(unit) && unit.envReads.some((read) => !read.allowed));
    if (mustGuard && !unit.imports.some((ref) => ref.specifier === 'server-only')) {
      violations.push(`${unit.file} must import 'server-only'`);
    }
  }
  return violations;
}

const SQL_KEYWORD = /\b(?:select|returning)\b/i;
const SQL_STAR = /\b(?:select|returning)\s+(?:distinct\s+)?\*|\b[a-z_][a-z0-9_]*\.\*/i;

/** Explicit column lists only (the blueprint's data access rules). */
function sqlSelectStar(modules: Modules): string[] {
  const violations: string[] = [];
  for (const unit of modules.values()) {
    for (const literal of unit.literals) {
      if (SQL_KEYWORD.test(literal.text) && SQL_STAR.test(literal.text)) {
        violations.push(`${unit.file}:${literal.line} "${literal.text.trim().slice(0, 80)}"`);
      }
    }
  }
  return violations;
}

// ── migrations ────────────────────────────────────────────────────────────────

interface MigrationFile {
  name: string;
  sql: string;
}

function loadMigrationFiles(): MigrationFile[] {
  return listFiles('supabase/migrations')
    .filter((file) => file.endsWith('.sql'))
    .map((file) => ({ name: path.posix.basename(file), sql: readFileSync(path.join(ROOT, file), 'utf8') }));
}

const withoutComments = (sql: string) => sql.replace(/(^|\s)--[^\n]*/g, '$1');
const statementsOf = (sql: string) => withoutComments(sql).split(';').map((statement) => statement.trim().replace(/\s+/g, ' '));

/** `schema.name`, or a bare name (created in public, the first schema on the search_path). */
const RELATION = String.raw`((?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)`;
const qualified = (name: string) => (name.includes('.') ? name : `public.${name}`).toLowerCase();
/** A role list such as `anon, authenticated`. */
const ROLES = String.raw`([a-z_]+(?: ?, ?[a-z_]+)*)`;
const onlyAuthenticated = (roles: string | undefined) =>
  roles !== undefined && roles.toLowerCase().split(',').map((role) => role.trim()).join(',') === 'authenticated';

interface MigrationModel {
  tables: string[];
  /** Tables whose latest row level security statement enables it. */
  rlsTables: Set<string>;
  /** CREATE POLICY and ALTER POLICY statements. */
  policies: string[];
  /** GRANT statements, including ALTER DEFAULT PRIVILEGES … GRANT. */
  grants: string[];
  functions: Array<{ name: string; header: string }>;
}

function parseMigrations(files: readonly MigrationFile[]): MigrationModel {
  const model: MigrationModel = { tables: [], rlsTables: new Set(), policies: [], grants: [], functions: [] };
  const createTable = new RegExp(String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?${RELATION}`, 'gi');
  const rowSecurity = new RegExp(
    String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${RELATION}\s+(enable|disable)\s+row\s+level\s+security`,
    'gi',
  );
  for (const { sql } of files) {
    const clean = withoutComments(sql);
    for (const match of clean.matchAll(createTable)) model.tables.push(qualified(match[1] ?? ''));
    // In migration order: a later DISABLE undoes an earlier ENABLE.
    for (const match of clean.matchAll(rowSecurity)) {
      const table = qualified(match[1] ?? '');
      if (match[2]?.toLowerCase() === 'enable') model.rlsTables.add(table);
      else model.rlsTables.delete(table);
    }
    for (const match of clean.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_.]*)\s*\(([^)]*)\)([\s\S]*?)\$\$/gi)) {
      model.functions.push({ name: qualified(match[1] ?? ''), header: (match[3] ?? '').replace(/\s+/g, ' ') });
    }
    for (const statement of statementsOf(sql)) {
      if (/^(?:create|alter) policy\b/i.test(statement)) model.policies.push(statement);
      if (/^(?:alter default privileges\b.*? )?grant\b/i.test(statement)) model.grants.push(statement);
    }
  }
  return model;
}

function migrationViolations(files: readonly MigrationFile[]): string[] {
  const model = parseMigrations(files);
  const violations: string[] = [];
  for (const table of model.tables) {
    if (!model.rlsTables.has(table)) violations.push(`table ${table} does not enable row level security`);
  }
  for (const policy of model.policies) {
    if (/^alter policy\b/i.test(policy)) {
      // ALTER POLICY … TO changes whom an existing policy applies to.
      const roles = new RegExp(String.raw`^alter policy \S+ on \S+ to ${ROLES}\b`, 'i').exec(policy)?.[1];
      if (roles !== undefined && !onlyAuthenticated(roles)) {
        violations.push(`policy must apply to authenticated only: ${policy.slice(0, 100)}`);
      }
      continue;
    }
    // Without TO, a policy applies to PUBLIC — including anon.
    const roles = new RegExp(String.raw`\bto ${ROLES} (?:using|with check)\b`, 'i').exec(policy)?.[1];
    if (!onlyAuthenticated(roles)) violations.push(`policy must apply to authenticated only: ${policy.slice(0, 100)}`);
  }
  for (const grant of model.grants) {
    const grantees = new RegExp(String.raw`\bto ${ROLES}$`, 'i').exec(grant)?.[1];
    if (!onlyAuthenticated(grantees)) violations.push(`grant must name authenticated only: ${grant.slice(0, 100)}`);
  }
  for (const fn of model.functions) {
    if (!/\bsecurity definer\b/i.test(fn.header)) continue;
    if (!/\bset search_path\b/i.test(fn.header)) violations.push(`security definer function ${fn.name} does not pin its search_path`);
    // An exposed schema would make it callable through the Data API (/rpc), and EXECUTE goes to PUBLIC by default.
    if (!fn.name.startsWith('app_private.')) violations.push(`security definer function ${fn.name} is outside app_private`);
  }
  return violations;
}

// ── tests ─────────────────────────────────────────────────────────────────────

/** The real code base plus synthetic modules. */
function synthetic(files: Record<string, string>): Modules {
  const known = new Set([...KNOWN_FILES, ...Object.keys(files)]);
  const modules = new Map(MODULES);
  for (const [file, code] of Object.entries(files)) modules.set(file, parseModule(file, code, known));
  return modules;
}

const sorted = (values: readonly string[]) => [...values].sort();

describe('provider boundaries', () => {
  it('only the OpenAI adapters import the OpenAI SDK', () => {
    expect(openAiSdkOutsideAdapter(MODULES)).toEqual([]);
  });

  it('only the provider factory wires the adapters, and only the composition root uses the factory', () => {
    expect(adapterWiring(MODULES)).toEqual([]);
  });

  it('model names appear only in src/server/config', () => {
    expect(modelNamesOutsideConfig(MODULES)).toEqual([]);
  });
});

describe('layering', () => {
  it('server code never imports routes, UI components or the browser widget', () => {
    expect(serverImportsUi(MODULES)).toEqual([]);
  });

  it('the domain and the agent core are channel-neutral', () => {
    expect(coreImportsChannels(MODULES)).toEqual([]);
  });

  it('business code never reaches for the composition root', () => {
    expect(businessCodeImportsCompositionRoot(MODULES)).toEqual([]);
  });

  it('public widget API routes go through the web chat channel service', () => {
    expect(apiRoutesBypassChannel(MODULES)).toEqual([]);
  });

  it('src/shared imports only shared modules and browser-safe packages', () => {
    expect(sharedNotIsomorphic(MODULES)).toEqual([]);
  });
});

describe('browser bundle', () => {
  it('nothing reachable from client code is server code or a server-only package', () => {
    expect(clientReachesServer(MODULES)).toEqual([]);
  });

  it('client code reads no environment variable except NODE_ENV', () => {
    expect(clientEnvReads(MODULES)).toEqual([]);
  });

  it("server entry modules import 'server-only'", () => {
    expect(unguardedServerEntries(MODULES)).toEqual([]);
  });
});

describe('database', () => {
  it('every migrated table keeps RLS on; policies and grants name only authenticated; definer functions are pinned and private', () => {
    expect(migrationViolations(loadMigrationFiles())).toEqual([]);
  });

  it('SQL selects explicit columns', () => {
    expect(sqlSelectStar(MODULES)).toEqual([]);
  });
});

describe('the checks see the code base', () => {
  it('parses every source module and resolves internal imports', () => {
    expect(MODULES.size).toBeGreaterThan(100);
    const route = MODULES.get('src/app/api/widget/messages/route.ts');
    expect(route?.imports.map((ref) => ref.target ?? ref.pkg)).toEqual(
      expect.arrayContaining(['next', 'src/server/app-services.ts', 'src/shared/widget-protocol.ts']) as unknown,
    );
    expect(MODULES.get('src/server/ai/openai/text-provider.ts')?.imports.some((ref) => ref.pkg === 'openai')).toBe(true);
    expect(MODULES.get('src/server/ai/providers.ts')?.imports.map((ref) => ref.target)).toContain(
      'src/server/ai/openai/text-provider.ts',
    );
  });

  it('finds the configured model names, client modules and environment reads', () => {
    const configLiterals = MODULES.get('src/server/config/env.ts')?.literals.map((literal) => literal.text) ?? [];
    expect(configLiterals).toEqual(expect.arrayContaining(['gpt-6-luna', 'gpt-6-sol', 'text-embedding-3-small']) as unknown);
    expect(MODULES.get('src/components/widget/ChatWidget.tsx')?.useClient).toBe(true);
    const closure = clientClosure(MODULES);
    expect(closure.get('src/shared/widget-protocol.ts')).toBeDefined();
    expect(closure.get('src/widget/chat-controller.ts')).toBeDefined();
    expect(MODULES.get('src/widget/chat-store.ts')?.envReads.some((read) => read.allowed)).toBe(true);
    expect(MODULES.get('src/server/config/env.ts')?.envReads.some((read) => !read.allowed)).toBe(true);
  });

  it('parses the migrations', () => {
    const model = parseMigrations(loadMigrationFiles());
    expect(model.tables.length).toBeGreaterThanOrEqual(17);
    expect(model.tables).toEqual(expect.arrayContaining(['public.organizations', 'public.messages', 'app_private.rate_limit_buckets']) as unknown);
    expect(model.policies.length).toBeGreaterThan(30);
    expect(model.grants.length).toBeGreaterThan(5);
    expect(model.functions.map((fn) => fn.name)).toEqual(
      expect.arrayContaining(['app_private.user_organization_ids', 'app_private.user_admin_organization_ids']) as unknown,
    );
  });
});

describe('the checks catch violations', () => {
  it('flags provider, model-name, layering and composition-root violations', () => {
    const modules = synthetic({
      'src/server/domain/leaky.ts': [
        "import type { ResponseInputItem } from 'openai/resources/responses/responses';",
        "import { WebChatError } from '@/server/channels/webchat/service';",
        "import { getAppServices } from '@/server/app-services';",
        "import { ChatWidget } from '@/components/widget/ChatWidget';",
        "import { OpenAITextProvider } from '../ai/openai/text-provider';",
        "export const model = `gpt-6-luna`;",
        "export type Services = import('@/server/services').AppServices;",
      ].join('\n'),
      'src/app/api/widget/leaky/route.ts': "export { getAgent } from '@/server/domain/agents/repository';",
      'src/server/agent/runtime/leaky.ts': "const factories = require('@/server/ai/providers');\nexport default factories;",
    });

    expect(openAiSdkOutsideAdapter(modules)).toEqual(['src/server/domain/leaky.ts:1 imports "openai/resources/responses/responses"']);
    expect(sorted(adapterWiring(modules))).toEqual([
      'src/server/agent/runtime/leaky.ts:1 imports "@/server/ai/providers"',
      'src/server/domain/leaky.ts:5 imports "../ai/openai/text-provider"',
    ]);
    expect(modelNamesOutsideConfig(modules)).toEqual(['src/server/domain/leaky.ts:6 "gpt-6-luna"']);
    expect(serverImportsUi(modules)).toEqual(['src/server/domain/leaky.ts:4 imports "@/components/widget/ChatWidget"']);
    expect(coreImportsChannels(modules)).toEqual(['src/server/domain/leaky.ts:2 imports "@/server/channels/webchat/service"']);
    expect(sorted(businessCodeImportsCompositionRoot(modules))).toEqual([
      'src/server/domain/leaky.ts:3 imports "@/server/app-services"',
      'src/server/domain/leaky.ts:7 imports "@/server/services"',
    ]);
    expect(apiRoutesBypassChannel(modules)).toEqual(['src/app/api/widget/leaky/route.ts:1 imports "@/server/domain/agents/repository"']);
  });

  it('flags server code, server-only packages and environment reads reachable from the browser', () => {
    const modules = synthetic({
      // A client component reaching server code through a module that is not client code itself.
      'src/components/widget/Leaky.tsx': [
        "'use client';",
        "import { helper } from '@/app/o/leaky-helper';",
        'export function Leaky() { return <p>{String(helper)}{process.env.OPENAI_API_KEY}</p>; }',
      ].join('\n'),
      'src/app/o/leaky-helper.ts': "export { isUuid as helper } from '@/server/db/sql';",
      'src/shared/leaky-hash.ts': "import { createHash } from 'node:crypto';\nexport const hash = createHash;",
      'src/widget/lazy.ts': "export const load = () => import('pg');\nexport const env = process.env;",
    });

    expect(sharedNotIsomorphic(modules)).toEqual(['src/shared/leaky-hash.ts:1 imports "node:crypto"']);
    expect(sorted(clientReachesServer(modules))).toEqual([
      'client code reaches src/server/db/sql.ts via src/components/widget/Leaky.tsx -> src/app/o/leaky-helper.ts -> src/server/db/sql.ts',
      'client code src/shared/leaky-hash.ts imports "node:crypto"',
      'client code src/widget/lazy.ts imports "pg"',
    ]);
    expect(sorted(clientEnvReads(modules))).toEqual([
      'src/components/widget/Leaky.tsx:3 reads process.env',
      'src/widget/lazy.ts:2 reads process.env',
    ]);
  });

  it("follows a 'use client' module anywhere into the whole server graph behind it", () => {
    const modules = synthetic({
      'src/app/o/leaky-client.tsx': "'use client';\nexport { getAppServices } from '@/server/app-services';",
    });
    const reached = clientReachesServer(modules);
    expect(reached).toContain('client code reaches src/server/app-services.ts via src/app/o/leaky-client.tsx -> src/server/app-services.ts');
    // Through the composition root: the OpenAI adapters and the server-only guards are flagged too.
    expect(reached.some((violation) => violation.startsWith('client code reaches src/server/ai/openai/'))).toBe(true);
    expect(reached.some((violation) => violation.endsWith('imports "openai"'))).toBe(true);
    expect(reached.some((violation) => violation.endsWith('imports "server-only"'))).toBe(true);
  });

  it('flags unguarded server entry modules and select *', () => {
    const modules = synthetic({
      'src/server/config/secrets.ts': "export const secret = process.env['WIDGET_SESSION_SECRET'];",
      'src/server/domain/star.ts': [
        "import type { Sql } from '@/server/db/types';",
        "export const all = (sql: Sql) => sql.query('select * from public.agents where organization_id = $1', ['x']);",
        'export const joined = (sql: Sql) => sql.query(`select a.*, c.id from public.agents a join public.agent_channels c on true`);',
      ].join('\n'),
    });
    expect(unguardedServerEntries(modules)).toEqual(["src/server/config/secrets.ts must import 'server-only'"]);
    expect(sorted(sqlSelectStar(modules))).toEqual([
      'src/server/domain/star.ts:2 "select * from public.agents where organization_id = $1"',
      'src/server/domain/star.ts:3 "select a.*, c.id from public.agents a join public.agent_channels c on true"',
    ]);
  });

  it('flags unsafe migrations', () => {
    const leaky: MigrationFile = {
      name: '29990101000000_leaky.sql',
      sql: [
        '-- create table public.commented_out (id uuid);',
        'create table public.leaky (id uuid primary key, organization_id uuid not null);',
        'create table leaky_bare (id uuid primary key);',
        'alter table public.messages disable row level security;',
        'create policy leaky_select on public.leaky for select using (true);',
        'create policy leaky_insert on public.leaky for insert to anon, authenticated with check (true);',
        'alter policy messages_select on public.messages to anon, authenticated;',
        'grant select on table public.leaky to anon;',
        'grant select on table public.leaky to service_role;',
        'alter default privileges in schema public grant select on tables to anon;',
        "create or replace function app_private.peek() returns setof uuid language sql stable security definer as $$ select id from public.leaky $$;",
        "create function peek_all() returns setof uuid language sql stable security definer set search_path = '' as $$ select id from public.leaky $$;",
      ].join('\n'),
    };
    expect(migrationViolations([...loadMigrationFiles(), leaky])).toEqual([
      'table public.messages does not enable row level security',
      'table public.leaky does not enable row level security',
      'table public.leaky_bare does not enable row level security',
      'policy must apply to authenticated only: create policy leaky_select on public.leaky for select using (true)',
      'policy must apply to authenticated only: create policy leaky_insert on public.leaky for insert to anon, authenticated with check (true)',
      'policy must apply to authenticated only: alter policy messages_select on public.messages to anon, authenticated',
      'grant must name authenticated only: grant select on table public.leaky to anon',
      'grant must name authenticated only: grant select on table public.leaky to service_role',
      'grant must name authenticated only: alter default privileges in schema public grant select on tables to anon',
      'security definer function app_private.peek does not pin its search_path',
      'security definer function public.peek_all is outside app_private',
    ]);
  });
});
