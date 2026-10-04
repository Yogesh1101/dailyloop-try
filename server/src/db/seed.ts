import { OperationSchema, PipelineSchema, SkillSchema } from '@harness/shared';
import { DEFAULT_OPERATIONS } from '../defaults/operations';
import { DEFAULT_PIPELINES } from '../defaults/pipelines';
import { DEFAULT_SKILLS } from '../defaults/skills';
import { getSettings } from '../engine/settings';
import { OperationModel, PipelineModel, SkillModel } from './models';

/** Insert built-in skills, operations and pipelines that do not exist yet. User edits are never overwritten. */
export async function seedDefaults(): Promise<{ skills: number; operations: number; pipelines: number }> {
  let skills = 0;
  let operations = 0;
  let pipelines = 0;
  for (const s of DEFAULT_SKILLS) {
    if (!(await SkillModel.exists({ slug: s.slug }))) {
      await SkillModel.create(SkillSchema.parse(s));
      skills++;
    }
  }
  for (const o of DEFAULT_OPERATIONS) {
    if (!(await OperationModel.exists({ key: o.key }))) {
      await OperationModel.create(OperationSchema.parse(o));
      operations++;
    }
  }
  for (const p of DEFAULT_PIPELINES) {
    if (!(await PipelineModel.exists({ key: p.key }))) {
      await PipelineModel.create(PipelineSchema.parse(p));
      pipelines++;
    }
  }
  await getSettings();
  return { skills, operations, pipelines };
}

export function builtInDefault(kind: 'skill' | 'operation' | 'pipeline', key: string) {
  if (kind === 'skill') return DEFAULT_SKILLS.find((s) => s.slug === key);
  if (kind === 'operation') {
    const o = DEFAULT_OPERATIONS.find((x) => x.key === key);
    return o && OperationSchema.parse(o);
  }
  const p = DEFAULT_PIPELINES.find((x) => x.key === key);
  return p && PipelineSchema.parse(p);
}
