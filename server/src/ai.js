const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/** Build a safe FTS5 MATCH expression from arbitrary user text. */
export function toFtsQuery(text) {
  const tokens = String(text)
    .toLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu);
  if (!tokens || tokens.length === 0) return null;
  // OR the terms so partial matches still rank; FTS5 bm25 handles relevance.
  return tokens.slice(0, 24).map((t) => `"${t}"`).join(' OR ');
}

/**
 * Ask-your-tabs: retrieve the most relevant archived pages via FTS5, then have
 * Claude answer the question grounded in that context, with citations.
 * The Anthropic key lives on the SERVER (env), never in the extension.
 */
export async function askYourTabs(q, { question, apiKey, model, topK = 8 }) {
  if (!apiKey) throw new Error('Server has no ANTHROPIC_API_KEY configured.');
  const match = toFtsQuery(question);
  if (!match) throw new Error('Question has no searchable terms.');

  const rows = q.ftsRetrieve.all(match, topK);
  if (rows.length === 0) {
    return { answer: "I couldn't find anything in your archived tabs about that yet.", citations: [] };
  }

  const context = rows
    .map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${String(r.body).slice(0, 1500)}`)
    .join('\n\n');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-opus-4-8',
      max_tokens: 1024,
      system:
        'You answer questions using ONLY the provided saved web pages. Cite sources inline as [n]. If the context does not contain the answer, say so plainly.',
      messages: [
        {
          role: 'user',
          content: `Question: ${question}\n\nSaved pages:\n${context}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const answer = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const citations = rows.map((r) => ({ url: r.url, title: r.title }));
  return { answer, citations };
}
