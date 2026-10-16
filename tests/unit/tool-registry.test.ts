import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { captureLead, phase1Tools, searchKnowledge } from '@/server/agent/tools/definitions';
import { agentCapabilities, createToolRegistry, toModelTools } from '@/server/agent/tools/registry';
import type { ToolDefinition } from '@/server/agent/tools/types';
import type { Agent } from '@/server/domain/agents/types';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    organizationId: '00000000-0000-4000-8000-0000000000b1',
    name: 'Front Desk',
    status: 'active',
    greeting: 'Hi! How can I help you today?',
    language: 'en',
    timezone: 'UTC',
    instructions: '',
    leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'testTool',
    description: 'A tool for tests.',
    input: z.object({ value: z.string() }),
    channels: ['web_chat'],
    requires: [],
    sideEffects: 'none',
    idempotency: 'none',
    label: 'Testing',
    handler: () => Promise.resolve({ ok: true, data: {} }),
    ...overrides,
  };
}

const names = (tools: readonly ToolDefinition[]) => tools.map((tool) => tool.name);

describe('phase 1 tools', () => {
  it('have stable names, web chat availability and the documented metadata', () => {
    expect(names(phase1Tools)).toEqual(['searchKnowledge', 'getBusinessInfo', 'getBusinessHours', 'captureLead']);
    for (const tool of phase1Tools) {
      expect(tool.channels).toEqual(['web_chat']);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.label).not.toBe('');
    }
    const [search, info, hours, lead] = phase1Tools;
    expect(search).toMatchObject({
      requires: ['knowledge'],
      sideEffects: 'none',
      idempotency: 'none',
      label: 'Searching our information',
      timeoutMs: 15_000,
    });
    expect(info).toMatchObject({ requires: ['business_info'], sideEffects: 'none', idempotency: 'none' });
    expect(hours).toMatchObject({ requires: ['business_info'], sideEffects: 'none', idempotency: 'none' });
    expect(lead).toMatchObject({
      requires: ['lead_capture'],
      sideEffects: 'writes',
      idempotency: 'conversation_arguments',
      label: 'Saving your details',
    });
  });

  it('validate searchKnowledge queries (trimmed, 2..300 characters)', () => {
    expect(searchKnowledge.input.parse({ query: '  emergency repair  ' })).toEqual({ query: 'emergency repair' });
    expect(searchKnowledge.input.safeParse({ query: ' a ' }).success).toBe(false);
    expect(searchKnowledge.input.safeParse({ query: 'x'.repeat(301) }).success).toBe(false);
    expect(searchKnowledge.input.safeParse({}).success).toBe(false);
  });

  it('treat null and blank captureLead details as not provided, and reject malformed contact details', () => {
    expect(captureLead.input.parse({ name: '  Jane Doe ', phone: '(555) 123-4567', email: '', summary: null })).toEqual({
      name: 'Jane Doe',
      phone: '(555) 123-4567',
      email: null,
      summary: null,
    });
    expect(captureLead.input.parse({})).toEqual({ name: null, phone: null, email: null, summary: null });
    expect(captureLead.input.safeParse({ phone: 'call me maybe' }).success).toBe(false);
    expect(captureLead.input.safeParse({ phone: '12345' }).success).toBe(false);
    expect(captureLead.input.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(captureLead.input.safeParse({ name: 'x'.repeat(161), email: 'jane@example.com' }).success).toBe(false);
    expect(captureLead.input.safeParse({ summary: 'x'.repeat(1001), email: 'jane@example.com' }).success).toBe(false);
  });
});

describe('createToolRegistry', () => {
  it('looks tools up by exact name only', () => {
    const registry = createToolRegistry(phase1Tools);
    expect(registry.get('searchKnowledge')).toBe(phase1Tools[0]);
    expect(registry.get('searchknowledge')).toBeUndefined();
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(registry.get(name)).toBeUndefined();
    }
    expect(names(registry.list())).toEqual(names(phase1Tools));
  });

  it('rejects duplicate tool names', () => {
    expect(() => createToolRegistry([makeTool(), makeTool()])).toThrow('Duplicate tool name "testTool"');
  });

  it('rejects names providers would not accept', () => {
    for (const name of ['', '1tool', 'has space', 'dash-name', 'dotted.name', 'x'.repeat(65), 'naïve']) {
      expect(() => createToolRegistry([makeTool({ name })]), name).toThrow('Invalid tool name');
    }
    expect(names(createToolRegistry([makeTool({ name: 'a' }), makeTool({ name: `A${'b_1'.repeat(21)}` })]).list())).toHaveLength(2);
  });

  it('rejects input schemas that are not objects at composition time', () => {
    expect(() => createToolRegistry([makeTool({ input: z.string() })])).toThrow('must take an object of arguments');
  });
});

describe('availableFor', () => {
  const registry = createToolRegistry(phase1Tools);

  it('offers every phase 1 tool to an agent with lead capture enabled', () => {
    expect(names(registry.availableFor(makeAgent(), 'web_chat'))).toEqual([
      'searchKnowledge',
      'getBusinessInfo',
      'getBusinessHours',
      'captureLead',
    ]);
  });

  it('never offers captureLead when lead capture is disabled', () => {
    const agent = makeAgent({ leadCapture: { enabled: false, requiredFields: ['name', 'phone'] } });
    expect(names(registry.availableFor(agent, 'web_chat'))).toEqual(['searchKnowledge', 'getBusinessInfo', 'getBusinessHours']);
  });

  it('respects channel availability and every capability requirement', () => {
    const custom = createToolRegistry([
      makeTool({ name: 'everywhere' }),
      makeTool({ name: 'nowhere', channels: [] }),
      makeTool({ name: 'needsLeads', requires: ['knowledge', 'lead_capture'] }),
    ]);
    expect(names(custom.availableFor(makeAgent(), 'web_chat'))).toEqual(['everywhere', 'needsLeads']);
    const noLeads = makeAgent({ leadCapture: { enabled: false, requiredFields: [] } });
    expect(names(custom.availableFor(noLeads, 'web_chat'))).toEqual(['everywhere']);
  });
});

describe('agentCapabilities', () => {
  it('always grants knowledge and business info, and lead capture only when enabled', () => {
    expect([...agentCapabilities(makeAgent())].sort()).toEqual(['business_info', 'knowledge', 'lead_capture']);
    const disabled = makeAgent({ leadCapture: { enabled: false, requiredFields: ['name'] } });
    expect([...agentCapabilities(disabled)].sort()).toEqual(['business_info', 'knowledge']);
  });
});

describe('toModelTools', () => {
  it('produces closed object schemas from the input side of each Zod schema', () => {
    const tools = toModelTools(phase1Tools);
    expect(tools.map((tool) => tool.name)).toEqual(names(phase1Tools));
    for (const [index, tool] of tools.entries()) {
      expect(tool.description).toBe(phase1Tools[index]!.description);
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(Object.keys(tool.parameters)).not.toContain('$schema');
      // Only plain JSON leaves the server (no Zod internals such as "~standard").
      expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(tool.parameters);
      expect(JSON.stringify(tool.parameters)).not.toContain('~standard');
    }

    const [search, info, , lead] = tools;
    expect(search!.parameters).toMatchObject({
      required: ['query'],
      properties: { query: { type: 'string', minLength: 2, maxLength: 300, description: expect.any(String) as unknown } },
    });
    expect(info!.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    // Every lead detail is optional for the model (and may be null): the handler asks for what is missing.
    expect(lead!.parameters.required).toBeUndefined();
    expect(Object.keys(lead!.parameters.properties)).toEqual(['name', 'phone', 'email', 'summary']);
    expect(lead!.parameters.properties.phone).toMatchObject({ anyOf: [{ type: 'string', maxLength: 40 }, { type: 'null' }] });
  });

  it('throws for a tool whose input is not an object schema', () => {
    expect(() => toModelTools([makeTool({ name: 'scalar', input: z.string() })])).toThrow(
      'Tool "scalar" must take an object of arguments',
    );
    const union = z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]);
    expect(() => toModelTools([makeTool({ name: 'either', input: union })])).toThrow('must take an object of arguments');
  });
});
