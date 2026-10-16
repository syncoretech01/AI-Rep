import { z } from 'zod';
import type { JsonObjectSchema, ModelToolDefinition } from '@/server/ai/types';
import type { Agent } from '@/server/domain/agents/types';
import type { Channel } from '@/server/domain/types';
import type { AgentCapability, ToolDefinition } from './types';

/**
 * The tools the platform offers, and which of them an agent may use on a
 * channel. Availability is decided here, server-side, from the agent's
 * configuration: a model can only ever be offered (and run) what the registry allows.
 */

/** Also what providers accept as function names. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface ToolRegistry {
  get(name: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
  /** Tools this agent may use on this channel: channel availability + capability requirements. */
  availableFor(agent: Agent, channel: Channel): ToolDefinition[];
}

export function createToolRegistry(definitions: readonly ToolDefinition[]): ToolRegistry {
  // A Map (not an object lookup): a model-chosen name like "constructor" must never resolve.
  const byName = new Map<string, ToolDefinition>();
  for (const definition of definitions) {
    if (!TOOL_NAME.test(definition.name)) throw new Error(`Invalid tool name "${definition.name}"`);
    if (byName.has(definition.name)) throw new Error(`Duplicate tool name "${definition.name}"`);
    byName.set(definition.name, definition);
  }
  const all: readonly ToolDefinition[] = Object.freeze([...byName.values()]);
  // Fail at composition time, not on a visitor's first message, if a schema cannot be offered to a model.
  toModelTools(all);

  return {
    get: (name) => byName.get(name),
    list: () => all,
    availableFor(agent, channel) {
      const capabilities = agentCapabilities(agent);
      return all.filter(
        (tool) => tool.channels.includes(channel) && tool.requires.every((capability) => capabilities.has(capability)),
      );
    },
  };
}

/** What an agent's configuration grants: knowledge and business facts always; lead capture only when enabled. */
export function agentCapabilities(agent: Agent): ReadonlySet<AgentCapability> {
  const capabilities = new Set<AgentCapability>(['knowledge', 'business_info']);
  if (agent.leadCapture.enabled) capabilities.add('lead_capture');
  return capabilities;
}

/** Provider-neutral tool definitions; arguments are still validated server-side with the Zod schema. */
export function toModelTools(definitions: readonly ToolDefinition[]): ModelToolDefinition[] {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: toParameters(definition),
  }));
}

function toParameters(definition: ToolDefinition): JsonObjectSchema {
  // `io: 'input'` describes what the model must SEND (before transforms and defaults apply).
  const { $schema: _dialect, ...schema } = z.toJSONSchema(definition.input, { io: 'input' });
  if (schema.type !== 'object') {
    throw new Error(`Tool "${definition.name}" must take an object of arguments`);
  }
  return { ...schema, type: 'object', properties: schema.properties ?? {}, additionalProperties: false };
}
