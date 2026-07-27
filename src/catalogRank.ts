/**
 * Semantic ranker for the in-memory node catalog — the read-side twin of the
 * agent's CatalogService (apps/workflow … UnoverseMCP/services/CatalogService.ts),
 * ported lean so the Unoverse server can rank ITS OWN migrated catalog without
 * reaching into workflow-service (whose ranker covers the legacy registry, which
 * diverges from the Unoverse set mid-migration).
 *
 * Ranking is a hybrid of embedding cosine similarity (semantic) blended with
 * lexical token overlap (exact keyword hits the embedding under-weights), the
 * same 0.8/0.2 blend and `text-embedding-3-large` model the agent uses, so the
 * workbench shortlist matches what UNO sees. Ranking RE-ORDERS, never filters —
 * the bounded `limit` is the only trim.
 *
 * The OpenAI key comes from the server process env (root .env, loaded at boot) —
 * the corpus is embedded with the SAME key/model so vectors are comparable. No
 * per-request credential: search is a catalog read, not a node execution.
 */

const OPENAI_EMBEDDING_URL = "https://api.openai.com/v1/embeddings";
const EMBED_MODEL = "text-embedding-3-large";
const EMBED_DIMENSIONS = 1536;
const REQUEST_TIMEOUT_MS = 30_000;

// 0.8*cosine + 0.2*lexical floor: below this, NO node strongly fits and `weak`
// is flagged so the UI can present the shortlist as a loose suggestion. Mirrors
// CatalogService.WEAK_SCORE_FLOOR — tuned by feel, adjust together.
const WEAK_SCORE_FLOOR = 0.28;

/** The catalog DTO routeNodes already builds — what the workbench renders. */
export interface CatalogNode {
  type: string;
  name: string;
  description?: string | null;
  whenToUse?: string | null;
  category?: string;
  [k: string]: unknown;
}

export interface RankResult {
  nodes: Array<CatalogNode & { relevance: number }>;
  ranked: true;
  weak: boolean;
  topScore: number;
}

// textHash → embedding. The corpus is tiny (~40 short docs) and changes only when
// nodes are added/migrated, so after the first ranked call we re-embed only the
// one-line query. Module-level: lives for the server process.
const embedCache = new Map<string, number[]>();

const hash = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
};

const tokenize = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2));

/** Fraction of query tokens present in the node text (0–1). */
function lexicalOverlap(queryTokens: Set<string>, nodeText: string): number {
  if (queryTokens.size === 0) return 0;
  const nodeTokens = tokenize(nodeText);
  let hits = 0;
  for (const t of queryTokens) if (nodeTokens.has(t)) hits++;
  return hits / queryTokens.size;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** What we embed per node — name + the intent line (whenToUse) + category, like the agent ranker. */
const textOf = (n: CatalogNode) =>
  `${n.name}. ${n.whenToUse || n.description || ""} [${n.category ?? ""}]`.trim();

/** Batch-embed inputs in one OpenAI call. Throws if the key is missing or the API errors. */
async function embed(inputs: string[], apiKey: string): Promise<number[][]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_EMBEDDING_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs, dimensions: EMBED_DIMENSIONS }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    // The API preserves request order, but sort by index to be safe.
    return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Re-order `nodes` by relevance to `task`, returning the top `limit` annotated
 * with a 0–1 `relevance`. Throws when no OpenAI key is configured or the API
 * fails — the caller falls back to an unranked list, never a wrong one.
 */
export async function rankNodes(nodes: CatalogNode[], task: string, limit: number): Promise<RankResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured — semantic ranking unavailable");
  if (nodes.length === 0) return { nodes: [], ranked: true, weak: true, topScore: 0 };

  // Embed any nodes not already cached (one batch call), then the query.
  const missing = nodes.filter((n) => !embedCache.has(hash(textOf(n))));
  if (missing.length > 0) {
    const vectors = await embed(missing.map(textOf), apiKey);
    missing.forEach((n, i) => embedCache.set(hash(textOf(n)), vectors[i]));
  }
  const [queryVec] = await embed([task], apiKey);
  const queryTokens = tokenize(task);

  const scored = nodes
    .map((n) => {
      const vec = embedCache.get(hash(textOf(n)))!;
      const score = 0.8 * cosine(queryVec, vec) + 0.2 * lexicalOverlap(queryTokens, textOf(n));
      return { node: { ...n, relevance: Math.round(score * 1000) / 1000 }, score };
    })
    .sort((a, b) => b.score - a.score);

  return {
    nodes: scored.slice(0, Math.max(1, limit)).map((s) => s.node),
    ranked: true,
    weak: scored[0].score < WEAK_SCORE_FLOOR,
    topScore: scored[0].score,
  };
}
