import mongoose from 'mongoose';
import { HttpError } from '../util/misc';

export function oid(id: string): string {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, 'Invalid id');
  return id;
}

export function notFound(what: string): never {
  throw new HttpError(404, `${what} not found`);
}

export const param = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : (v ?? ''));
