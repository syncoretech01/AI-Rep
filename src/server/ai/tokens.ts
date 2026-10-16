/**
 * Cheap, provider-neutral token estimate used for context budgeting and
 * chunk sizing (~4 characters per token for English prose, rounded up).
 * Billing never uses this: metering records provider-reported usage.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Truncates `text` to roughly `maxTokens`, preferring a word boundary. */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens * 4);
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
