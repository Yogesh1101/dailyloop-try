import { Ajv } from 'ajv';
import type { ArtifactContract, JsonAssertion } from '@harness/shared';

const ajv = new Ajv({ allErrors: true, strict: false });
const PLACEHOLDER = /\b(TODO|TBD|FIXME|lorem ipsum|XXX)\b/;

export interface Validation {
  valid: boolean;
  errors: string[];
  parsed?: unknown;
}

const norm = (s: string) => s.replace(/[*_`]/g, '').trim().toLowerCase();

/** Markdown headings with the text of their sections (until the next heading of the same or higher level). */
export function markdownSections(md: string): { level: number; title: string; body: string }[] {
  const lines = md.split('\n');
  const heads: { level: number; title: string; line: number }[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) heads.push({ level: m[1].length, title: m[2], line: i });
  });
  return heads.map((h, idx) => {
    let end = lines.length;
    for (let j = idx + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        end = heads[j].line;
        break;
      }
    }
    return { level: h.level, title: h.title, body: lines.slice(h.line + 1, end).join('\n') };
  });
}

/** Text of a named section (case-insensitive), or undefined. */
export function sectionText(md: string, title: string): string | undefined {
  return markdownSections(md).find((s) => norm(s.title) === norm(title))?.body.trim();
}

export function validateArtifact(contract: ArtifactContract, content: string | null): Validation {
  const errors: string[] = [];
  if (content === null) {
    return { valid: false, errors: [`Missing artifact file "${contract.path}". You must write it before calling finish.`] };
  }
  if (!content.trim()) return { valid: false, errors: [`Artifact "${contract.path}" is empty.`] };
  if (content.length < contract.minChars) {
    errors.push(`Artifact "${contract.path}" has ${content.length} characters; the contract requires at least ${contract.minChars}.`);
  }
  for (const rp of contract.requiredPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(rp.pattern, 'im');
    } catch {
      errors.push(`Contract error: invalid pattern /${rp.pattern}/`);
      continue;
    }
    if (!re.test(content)) errors.push(`Artifact "${contract.path}" must contain ${rp.description} (pattern /${rp.pattern}/).`);
  }

  let parsed: unknown;
  if (contract.format === 'markdown') {
    const sections = markdownSections(content);
    for (const h of contract.requiredHeadings) {
      const s = sections.find((x) => norm(x.title) === norm(h));
      if (!s) errors.push(`Missing required section heading "${h}".`);
      else if (!s.body.replace(/<!--[\s\S]*?-->/g, '').trim()) errors.push(`Required section "${h}" is empty.`);
    }
    if (contract.rejectPlaceholders) {
      const m = PLACEHOLDER.exec(content);
      if (m) errors.push(`Artifact "${contract.path}" contains placeholder text "${m[0]}". Replace every placeholder with real content.`);
    }
  } else {
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return { valid: false, errors: [...errors, `Artifact "${contract.path}" is not valid JSON: ${(e as Error).message}`] };
    }
    if (contract.jsonSchema) {
      let validate;
      try {
        validate = ajv.compile(contract.jsonSchema);
      } catch (e) {
        errors.push(`Contract error: invalid JSON Schema for "${contract.id}": ${(e as Error).message}`);
      }
      if (validate && !validate(parsed)) {
        for (const err of validate.errors ?? []) {
          errors.push(`"${contract.path}" ${err.instancePath || '(root)'} ${err.message}${err.params ? ` ${JSON.stringify(err.params)}` : ''}`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors, parsed };
}

/**
 * Select values by a small path language:
 *   `a.b`               property access
 *   `tasks[].files`     flatten arrays
 *   `findings[?severity==blocker]` filter array items by a field value
 */
export function selectPath(root: unknown, expr: string): unknown[] {
  let current: unknown[] = [root];
  for (const raw of expr.split('.').filter(Boolean)) {
    const m = /^([\w$-]+)(\[\]|\[\?([\w$-]+)\s*==\s*([^\]]+)\])?$/.exec(raw);
    if (!m) throw new Error(`Invalid path segment "${raw}" in "${expr}"`);
    const [, key, bracket, fKey, fVal] = m;
    const next: unknown[] = [];
    for (const v of current) {
      if (v === null || typeof v !== 'object') continue;
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined) continue;
      if (!bracket) next.push(child);
      else if (Array.isArray(child)) {
        if (bracket === '[]') next.push(...child);
        else {
          const want = fVal.trim().replace(/^['"]|['"]$/g, '');
          next.push(...child.filter((it) => it && typeof it === 'object' && String((it as any)[fKey]) === want));
        }
      }
    }
    current = next;
  }
  return current;
}

export function evaluateAssertion(doc: unknown, a: JsonAssertion): { passed: boolean; actual: unknown } {
  const values = selectPath(doc, a.path);
  const count = values.length === 1 && Array.isArray(values[0]) ? values[0].length : values.length;
  const first = values[0];
  switch (a.op) {
    case 'exists':
      return { passed: values.length > 0 && first !== null, actual: first };
    case 'eq':
      return { passed: values.length > 0 && JSON.stringify(first) === JSON.stringify(a.value), actual: first };
    case 'neq':
      return { passed: JSON.stringify(first) !== JSON.stringify(a.value), actual: first };
    case 'in':
      return { passed: Array.isArray(a.value) && a.value.some((x) => JSON.stringify(x) === JSON.stringify(first)), actual: first };
    case 'count_eq':
      return { passed: count === Number(a.value), actual: count };
    case 'count_lte':
      return { passed: count <= Number(a.value), actual: count };
    case 'count_gte':
      return { passed: count >= Number(a.value), actual: count };
  }
}
