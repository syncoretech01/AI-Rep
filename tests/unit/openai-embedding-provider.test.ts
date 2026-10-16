import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { OpenAIEmbeddingProvider } from '@/server/ai/openai/embedding-provider';
import { ProviderError } from '@/server/ai/types';

type Reply = (body: Record<string, unknown>, signal: AbortSignal | undefined) => Response | Promise<Response>;

function fakeClient(reply: Reply) {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new OpenAI({
    apiKey: 'sk-test',
    maxRetries: 0,
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      bodies.push(body);
      return reply(body, init?.signal ?? undefined);
    },
  });
  return { client, bodies };
}

/** Embeddings API response; honours the SDK's default base64 wire encoding. */
function embeddingsResponse(body: Record<string, unknown>, data: Array<{ index: number; vector: number[] }>, promptTokens: number) {
  const base64 = body.encoding_format === 'base64';
  return new Response(
    JSON.stringify({
      object: 'list',
      model: 'test-embed-model',
      data: data.map(({ index, vector }) => ({
        object: 'embedding',
        index,
        embedding: base64 ? Buffer.from(new Float32Array(vector).buffer).toString('base64') : vector,
      })),
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function jsonError(status: number, code: string) {
  return new Response(JSON.stringify({ error: { message: 'Input was: secret text', type: 'x', code, param: null } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Float32-exact values so base64 round-trips compare exactly.
const ALPHA = [0.5, -0.25, 1];
const BETA = [0.125, -1, 0.75];
const GAMMA = [2, -0.5, 0.0625];

describe('OpenAIEmbeddingProvider', () => {
  it('sends model, inputs and dimensions and returns vectors in input order', async () => {
    const { client, bodies } = fakeClient((body) =>
      embeddingsResponse(
        body,
        [
          { index: 2, vector: GAMMA },
          { index: 0, vector: ALPHA },
          { index: 1, vector: BETA },
        ],
        7,
      ),
    );
    const provider = new OpenAIEmbeddingProvider({ client, timeoutMs: 5_000 });

    const result = await provider.embed({ model: 'test-embed', input: ['alpha', 'beta', 'gamma'], dimensions: 3 });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: 'test-embed', input: ['alpha', 'beta', 'gamma'], dimensions: 3 });
    expect(result).toEqual({
      provider: 'openai',
      model: 'test-embed-model',
      vectors: [ALPHA, BETA, GAMMA],
      usage: { inputTokens: 7 },
      durationMs: expect.any(Number) as number,
    });
  });

  it('omits dimensions when the request does not set them', async () => {
    const { client, bodies } = fakeClient((body) => embeddingsResponse(body, [{ index: 0, vector: ALPHA }], 1));
    await new OpenAIEmbeddingProvider({ client, timeoutMs: 5_000 }).embed({ model: 'test-embed', input: ['alpha'] });
    expect(bodies[0]).not.toHaveProperty('dimensions');
  });

  it.each([
    [401, 'invalid_api_key', 'auth', false],
    [429, 'rate_limit_exceeded', 'rate_limited', true],
    [500, 'server_error', 'unavailable', true],
  ] as const)('maps HTTP %i (%s) to %s', async (status, code, expected, retryable) => {
    const { client } = fakeClient(() => jsonError(status, code));
    const error = await new OpenAIEmbeddingProvider({ client, timeoutMs: 5_000 })
      .embed({ model: 'test-embed', input: ['secret text'] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: 'openai', code: expected, retryable, status });
    expect((error as ProviderError).message).not.toContain('secret text');
  });

  it('rejects input the API would refuse without calling it', async () => {
    const { client, bodies } = fakeClient(() => {
      throw new Error('must not be called');
    });
    const provider = new OpenAIEmbeddingProvider({ client, timeoutMs: 5_000 });
    for (const input of [[], ['ok', ''], Array.from({ length: 2049 }, () => 'x')]) {
      await expect(provider.embed({ model: 'test-embed', input })).rejects.toMatchObject({
        code: 'invalid_request',
        retryable: false,
      });
    }
    expect(bodies).toHaveLength(0);
  });

  it('distinguishes a caller abort from a deadline', async () => {
    const hang: Reply = (_body, signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });

    const aborted = fakeClient(hang);
    await expect(
      new OpenAIEmbeddingProvider({ client: aborted.client, timeoutMs: 5_000 }).embed({
        model: 'test-embed',
        input: ['alpha'],
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'aborted', retryable: false });

    const stalled = fakeClient(hang);
    await expect(
      new OpenAIEmbeddingProvider({ client: stalled.client, timeoutMs: 100 }).embed({ model: 'test-embed', input: ['alpha'] }),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });

  it('uses a custom provider id in results and errors', async () => {
    const { client } = fakeClient((body) => embeddingsResponse(body, [{ index: 0, vector: ALPHA }], 1));
    const result = await new OpenAIEmbeddingProvider({ client, timeoutMs: 5_000, id: 'openai-eu' }).embed({
      model: 'test-embed',
      input: ['alpha'],
    });
    expect(result.provider).toBe('openai-eu');

    const failing = fakeClient(() => jsonError(500, 'server_error'));
    await expect(
      new OpenAIEmbeddingProvider({ client: failing.client, timeoutMs: 5_000, id: 'openai-eu' }).embed({
        model: 'test-embed',
        input: ['alpha'],
      }),
    ).rejects.toMatchObject({ provider: 'openai-eu', code: 'unavailable', message: expect.stringMatching(/^openai-eu: /) as string });
  });
});
