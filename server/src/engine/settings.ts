import { DEFAULT_MODELS, SettingsSchema, type ModelInfo, type Settings } from '@harness/shared';
import { SettingsModel, UsageRecordModel } from '../db/models';
import { startOfMonth } from '../util/misc';

const KEY = 'global';

export async function getSettings(): Promise<Settings> {
  let doc = await SettingsModel.findOne({ key: KEY }).lean();
  if (!doc) {
    const defaults = SettingsSchema.parse({ models: DEFAULT_MODELS });
    await SettingsModel.create({ key: KEY, ...defaults });
    doc = await SettingsModel.findOne({ key: KEY }).lean();
  }
  return SettingsSchema.parse(doc);
}

export async function updateSettings(input: unknown): Promise<Settings> {
  const parsed = SettingsSchema.parse(input);
  await SettingsModel.updateOne({ key: KEY }, { $set: parsed }, { upsert: true });
  return getSettings();
}

export function priceLookup(settings: Settings): (model: string) => ModelInfo | undefined {
  const byId = new Map(settings.models.map((m) => [m.id, m]));
  return (model: string) => {
    if (byId.has(model)) return byId.get(model);
    // Served model ids can carry suffixes; fall back to the longest catalog prefix.
    let best: ModelInfo | undefined;
    for (const m of settings.models) if (model.startsWith(m.id) && (!best || m.id.length > best.id.length)) best = m;
    return best;
  };
}

/** Spend this calendar month (server local time), from per-turn usage records. */
export async function monthSpend(): Promise<number> {
  const rows = await UsageRecordModel.find({ ts: { $gte: startOfMonth() } }, { costUsd: 1 }).lean();
  return rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
}
