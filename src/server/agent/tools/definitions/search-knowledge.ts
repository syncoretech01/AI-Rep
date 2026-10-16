import { z } from 'zod';
import { ProviderError } from '@/server/ai/types';
import { truncateText } from '@/server/db/sql';
import { searchKnowledge as retrieveKnowledge } from '@/server/domain/knowledge/retrieval';
import { defineTool, type ToolOutcome } from '../types';

const input = z.object({
  query: z
    .string()
    .trim()
    .min(2)
    .max(300)
    .describe("A short, self-contained search query for the visitor's question, e.g. 'emergency boiler repair price'."),
});

export interface KnowledgeResult {
  source: string;
  content: string;
}

export interface SearchKnowledgeData {
  results: KnowledgeResult[];
  note?: string;
}

/**
 * Serialized size budget for the results. Retrieval caps chunks by tokens; this keeps the
 * tool output well inside the executor's output limit even when the retrieval budget is raised.
 */
const MAX_RESULTS_CHARS = 9_000;
/** Chunks are ~450 tokens at most, so this never cuts real chunk content; it only bounds one oversized row. */
const MAX_RESULT_CONTENT_CHARS = 4_000;

const NO_RESULTS_NOTE =
  'No relevant information found. Do not guess: tell the visitor you do not have that information and offer to take their details.';

export const searchKnowledge = defineTool({
  name: 'searchKnowledge',
  description:
    "Search the business's knowledge base (services, prices, policies, FAQs and other business information). " +
    'Call it before answering any such question. Answer only from the returned results; if there are none, ' +
    'say you do not have that information. Never guess.',
  input,
  channels: ['web_chat'],
  requires: ['knowledge'],
  sideEffects: 'none',
  idempotency: 'none',
  label: 'Searching our information',
  timeoutMs: 15_000,
  async handler({ query }, ctx): Promise<ToolOutcome<SearchKnowledgeData>> {
    const chunks = await retrieveKnowledge(ctx.db, ctx.embedder, {
      organizationId: ctx.organizationId,
      agentId: ctx.agent.id,
      conversationId: ctx.conversationId,
      query,
      budget: ctx.retrieval,
    }).catch((error: unknown) => {
      // An embedding outage must never read as "the business has no such information".
      if (error instanceof ProviderError) return null;
      throw error;
    });
    if (chunks === null) {
      return {
        ok: false,
        error: { code: 'unavailable', message: 'The knowledge base is temporarily unavailable.', retryable: true },
      };
    }

    const results: KnowledgeResult[] = [];
    let size = 0;
    for (const chunk of chunks) {
      const result = { source: chunk.sourceTitle, content: truncateText(chunk.content, MAX_RESULT_CONTENT_CHARS, '…') };
      size += JSON.stringify(result).length + 1;
      // Ordered by relevance: the best result is always kept, weaker ones only while they fit.
      if (results.length > 0 && size > MAX_RESULTS_CHARS) break;
      results.push(result);
    }
    if (results.length === 0) return { ok: true, data: { results: [], note: NO_RESULTS_NOTE } };
    return { ok: true, data: { results } };
  },
});
