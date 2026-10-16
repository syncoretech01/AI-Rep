import type { ToolDefinition } from '../types';
import { captureLead } from './capture-lead';
import { getBusinessHours } from './get-business-hours';
import { getBusinessInfo } from './get-business-info';
import { searchKnowledge } from './search-knowledge';

/** Phase 1 server tools. Names are a stable API (models and stored transcripts refer to them). */
export const phase1Tools: readonly ToolDefinition[] = Object.freeze([
  searchKnowledge,
  getBusinessInfo,
  getBusinessHours,
  captureLead,
]);

export { captureLead, getBusinessHours, getBusinessInfo, searchKnowledge };
