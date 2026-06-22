import type { SavedTab, Session } from './types';
import { getSettings } from './settings';
import { db } from './db';
import { tabCount } from './sessions';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AiGroup {
  name: string;
  /** indices into the flat tab list passed to the model */
  tabIndices: number[];
}

export interface AiGroupResult {
  summary: string;
  suggestedName: string;
  groups: AiGroup[];
}

/**
 * Ask Claude to cluster a session's tabs into named topical groups and
 * suggest a session name + one-line summary.
 *
 * Uses the public Messages API with the dangerous browser-access header so it
 * works directly from the extension (the key lives only in local storage).
 */
export async function groupSessionWithAi(session: Session): Promise<AiGroupResult> {
  const settings = await getSettings();
  if (!settings.aiEnabled) throw new Error('AI is disabled in settings.');
  if (!settings.anthropicApiKey) throw new Error('No Anthropic API key configured.');

  const tabs = flatTabs(session);
  const list = tabs
    .map((t, i) => `${i}. ${t.title} — ${t.url}`)
    .join('\n')
    .slice(0, 24000); // keep the prompt bounded

  const tool = {
    name: 'emit_groups',
    description: 'Return the topical grouping of the tabs.',
    input_schema: {
      type: 'object',
      properties: {
        suggestedName: { type: 'string', description: 'Concise session name, max 6 words.' },
        summary: { type: 'string', description: 'One sentence describing the session.' },
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short topic label, max 4 words.' },
              tabIndices: { type: 'array', items: { type: 'integer' } },
            },
            required: ['name', 'tabIndices'],
          },
        },
      },
      required: ['suggestedName', 'summary', 'groups'],
    },
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.anthropicApiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: settings.aiModel,
      max_tokens: 2048,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'emit_groups' },
      messages: [
        {
          role: 'user',
          content: `Group these ${tabs.length} browser tabs into coherent topical clusters. Every tab index must appear in exactly one group.\n\n${list}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  const block = (data.content ?? []).find((b: any) => b.type === 'tool_use');
  if (!block) throw new Error('Model returned no grouping.');
  return block.input as AiGroupResult;
}

/**
 * Apply an AI result to a session: re-tag tabs with group titles, write the
 * summary + suggested tags, and persist.
 */
export async function applyAiGroups(sessionId: string, result: AiGroupResult): Promise<Session | undefined> {
  const session = await db.sessions.get(sessionId);
  if (!session) return;
  // map index → group name
  const indexToGroup = new Map<number, string>();
  for (const g of result.groups) for (const idx of g.tabIndices) indexToGroup.set(idx, g.name);

  let i = 0;
  for (const w of session.windows) {
    for (const t of w.tabs) {
      const g = indexToGroup.get(i);
      if (g) t.groupTitle = g;
      i++;
    }
  }

  session.summary = result.summary;
  session.tags = Array.from(new Set([...session.tags, ...result.groups.map((g) => g.name.toLowerCase())])).slice(0, 12);
  session.updatedAt = Date.now();
  session.rev += 1;
  session.dirty = true;
  await db.sessions.put(session);
  return session;
}

function flatTabs(session: Session): SavedTab[] {
  return session.windows.flatMap((w) => w.tabs);
}

/** Heuristic, zero-cost grouping fallback (by registrable-ish domain). */
export function groupByDomain(session: Session): AiGroupResult {
  const flat = flatTabs(session);
  const byDomain = new Map<string, number[]>();
  flat.forEach((t, i) => {
    let host = 'other';
    try {
      host = new URL(t.url).hostname.replace(/^www\./, '');
    } catch {
      /* keep other */
    }
    byDomain.set(host, [...(byDomain.get(host) ?? []), i]);
  });
  return {
    suggestedName: session.name,
    summary: `${tabCount(session)} tabs across ${byDomain.size} sites`,
    groups: [...byDomain.entries()].map(([name, tabIndices]) => ({ name, tabIndices })),
  };
}
