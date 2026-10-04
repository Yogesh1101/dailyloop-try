import type { Run } from '@harness/shared';
import { KnowledgeModel } from '../db/models';
import type { KnowledgeSnippet } from '../engine/prompt';

const STOP = new Set(
  'the and for with that this from into have will must should would could when then than your their there what which while about after before using use add make sure each every also only just like need needs task stage'.split(' '),
);

export function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])].filter((t) => !STOP.has(t));
}

/**
 * Knowledge retrieval: pinned entries always, then the most relevant others by
 * keyword overlap (title > tags > body), capped by a character budget.
 */
export async function retrieveKnowledge(repoId: string, query: string, limit = 6, maxChars = 24_000): Promise<KnowledgeSnippet[]> {
  const entries = await KnowledgeModel.find({ $or: [{ repoId }, { repoId: null }] }).lean();
  const terms = tokenize(query);
  const scored = entries
    .filter((e) => !e.pinned)
    .map((e) => {
      const title = e.title.toLowerCase();
      const body = e.content.toLowerCase();
      const tags = (e.tags ?? []).map((t) => t.toLowerCase());
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 3;
        if (tags.some((x) => x.includes(t))) score += 2;
        score += Math.min(5, body.split(t).length - 1) * 0.5;
      }
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || +new Date(b.e.updatedAt as Date) - +new Date(a.e.updatedAt as Date))
    .slice(0, limit)
    .map((x) => x.e);

  const out: KnowledgeSnippet[] = [];
  let used = 0;
  for (const e of [...entries.filter((x) => x.pinned), ...scored]) {
    if (used + e.content.length > maxChars) continue;
    used += e.content.length;
    out.push({ type: e.type, title: e.title, content: e.content, pinned: !!e.pinned });
  }
  return out;
}

/** Save approved artifacts marked `captureToKnowledge` so future runs inherit the decisions. */
export async function captureRunKnowledge(run: Pick<Run, 'repoId' | 'title' | 'stages'> & { _id: unknown }): Promise<number> {
  let n = 0;
  for (const stage of run.stages) {
    if (stage.status !== 'passed') continue;
    for (const contract of stage.snapshot.artifacts) {
      if (!contract.captureToKnowledge) continue;
      const art = stage.artifacts.find((a) => a.id === contract.id);
      if (!art?.valid) continue;
      await KnowledgeModel.create({
        repoId: run.repoId,
        type: contract.id.startsWith('spec') ? 'spec' : 'decision',
        title: `${stage.name} — ${run.title}`,
        content: art.content,
        tags: [stage.operationKey, 'from-run'],
        pinned: false,
        source: 'run',
        runId: String(run._id),
      });
      n += 1;
    }
  }
  return n;
}
