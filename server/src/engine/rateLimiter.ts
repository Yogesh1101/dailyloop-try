export interface RateLimits {
  /** Requests per minute. */
  rpm?: number;
  /** Tokens (input + output) per minute. */
  tpm?: number;
}

interface Window {
  reqs: number[];
  tokens: { t: number; n: number }[];
  blockedUntil: number;
}

const MINUTE = 60_000;

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Run cancelled', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Run cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Client-side pacing per provider+model (free-tier quotas are per project per model).
 * Sliding one-minute windows over requests and tokens, shared by every run in the process,
 * plus a cool-down when the provider itself returned a 429.
 */
export class RateLimiter {
  private windows = new Map<string, Window>();

  constructor(
    private now: () => number = () => Date.now(),
    private sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
  ) {}

  private window(key: string): Window {
    let w = this.windows.get(key);
    if (!w) {
      w = { reqs: [], tokens: [], blockedUntil: 0 };
      this.windows.set(key, w);
    }
    const cutoff = this.now() - MINUTE;
    while (w.reqs.length && w.reqs[0] <= cutoff) w.reqs.shift();
    while (w.tokens.length && w.tokens[0].t <= cutoff) w.tokens.shift();
    return w;
  }

  /** How long the next request (of `estTokens`) must wait, in ms. 0 = go now. */
  waitFor(key: string, limits: RateLimits, estTokens: number): number {
    const w = this.window(key);
    const now = this.now();
    let wait = Math.max(0, w.blockedUntil - now);
    if (limits.rpm && w.reqs.length >= limits.rpm) wait = Math.max(wait, w.reqs[w.reqs.length - limits.rpm] + MINUTE - now);
    if (limits.tpm && w.tokens.length) {
      const used = w.tokens.reduce((s, e) => s + e.n, 0);
      // A request bigger than the whole budget can never fit: let it go once the window is empty.
      const need = Math.min(estTokens, limits.tpm);
      if (used + need > limits.tpm) {
        let freed = 0;
        for (const e of w.tokens) {
          freed += e.n;
          if (used - freed + need <= limits.tpm) {
            wait = Math.max(wait, e.t + MINUTE - now);
            break;
          }
        }
      }
    }
    return Math.max(0, Math.ceil(wait));
  }

  /**
   * Wait until a request fits, then reserve it. Returns `commit(actualTokens)` to replace the
   * estimate with real usage once the response arrives.
   */
  async acquire(
    key: string,
    limits: RateLimits,
    estTokens: number,
    opts: { signal?: AbortSignal; onWait?: (ms: number) => void; maxWaitMs?: number } = {},
  ): Promise<(actualTokens: number) => void> {
    let waited = 0;
    for (;;) {
      const wait = this.waitFor(key, limits, estTokens);
      if (wait <= 0) break;
      if (opts.maxWaitMs !== undefined && waited + wait > opts.maxWaitMs) {
        throw new RateLimitWaitExceeded(waited + wait);
      }
      opts.onWait?.(wait);
      await this.sleep(wait + 25, opts.signal);
      waited += wait + 25;
    }
    const w = this.window(key);
    const t = this.now();
    w.reqs.push(t);
    const entry = { t, n: estTokens };
    if (limits.tpm) w.tokens.push(entry);
    return (actual: number) => {
      entry.n = actual;
    };
  }

  /** The provider returned a 429: hold every request on this key until `untilMs`. */
  coolDown(key: string, ms: number) {
    const w = this.window(key);
    w.blockedUntil = Math.max(w.blockedUntil, this.now() + ms);
  }
}

export class RateLimitWaitExceeded extends Error {
  constructor(public neededMs: number) {
    super(`Pacing would need to wait ${Math.round(neededMs / 1000)}s`);
  }
}

/** One limiter for the whole server process. */
export const sharedLimiter = new RateLimiter();
