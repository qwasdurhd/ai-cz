// Best-effort context-window (token limit) lookup for popular models.
// Values are the documented ceilings; unknown models return null so the UI can
// show "غير معروف" instead of guessing. Ordered so specific patterns win first.
const MODEL_LIMITS: Array<{ match: RegExp; limit: number }> = [
  { match: /gpt-4\.1/i, limit: 1047576 },
  { match: /gpt-4o-mini/i, limit: 128000 },
  { match: /gpt-4o/i, limit: 128000 },
  { match: /gpt-4-turbo/i, limit: 128000 },
  { match: /gpt-4/i, limit: 8192 },
  { match: /gpt-3\.5/i, limit: 16385 },
  { match: /(^|[/-])o1|(^|[/-])o3|(^|[/-])o4-mini/i, limit: 200000 },
  { match: /claude-3[.-]?5|claude-3[.-]?7|claude-3-opus|claude-3-sonnet|claude-3-haiku/i, limit: 200000 },
  { match: /claude/i, limit: 200000 },
  { match: /gemini-1\.5|gemini-2/i, limit: 1000000 },
  { match: /gemini/i, limit: 32768 },
  { match: /llama-3|llama3|llama-4/i, limit: 131072 },
  { match: /llama-2/i, limit: 4096 },
  { match: /deepseek/i, limit: 65536 },
  { match: /xingchen|xing4\.0/i, limit: 262144 },
  { match: /qwen/i, limit: 131072 },
  { match: /mixtral|mistral/i, limit: 32768 },
  { match: /venice-uncensored/i, limit: 8192 },
  { match: /venice/i, limit: 32000 },
  { match: /cz-pro|cz-reasoner|cz-coder|cz-vision|cz-fast/i, limit: 128000 },
  { match: /command-r/i, limit: 131072 },
  { match: /gemma-4|gemma4/i, limit: 262144 },
  { match: /gemma-3|gemma3/i, limit: 131072 },
  { match: /gemma/i, limit: 8192 },
];

/** Returns the documented context window (tokens) for a model, or null when unknown. */
export function modelTokenLimit(model: string | null | undefined): number | null {
  const value = (model ?? "").trim();
  if (!value) return null;
  for (const entry of MODEL_LIMITS) {
    if (entry.match.test(value)) return entry.limit;
  }
  return null;
}

/** "128K توكن" / "1M توكن" / "غير معروف" — a short, readable token-limit label. */
export function formatTokenLimit(model: string | null | undefined): string {
  const limit = modelTokenLimit(model);
  if (limit == null) return "غير معروف";
  if (limit >= 1000000) return `${(limit / 1000000).toFixed(limit % 1000000 === 0 ? 0 : 1)}M توكن`;
  if (limit >= 1000) return `${Math.round(limit / 1000)}K توكن`;
  return `${limit.toLocaleString("ar-SA")} توكن`;
}
