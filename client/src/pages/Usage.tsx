import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, compact, usd } from '../api';
import { Card, Empty, PageHead, Seg, StatusPill } from '../components/ui';

interface Group {
  key: string;
  costUsd: number;
  tokens: number;
  turns: number;
}
interface Summary {
  days: number;
  totals: { costUsd: number; tokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; turns: number; runs: number };
  month: { spentUsd: number; budgetUsd: number; since: string };
  byDay: Group[];
  byOperation: Group[];
  byModel: Group[];
  byRepo: Group[];
  topRuns: (Group & { title: string; status: string; repoName: string })[];
}
type Metric = 'costUsd' | 'tokens';

const fmt = (m: Metric, n: number) => (m === 'costUsd' ? usd(n) : compact(Math.round(n)));

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? 10 * mag;
  return step * 4;
}

/** Single-series column chart: thin bars, 4px rounded data-ends, hairline grid, per-bar tooltip on hover and focus. */
function ColumnChart({ data, metric }: { data: Group[]; metric: Metric }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(760);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const H = 240;
  const pad = { l: 56, r: 8, t: 12, b: 28 };
  const plotW = w - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const values = data.map((d) => d[metric]);
  const max = niceMax(Math.max(...values, 0));
  const band = plotW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(24, band - 2));
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 64))));
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const label = (k: string) => new Date(`${k}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const bar = (x: number, y: number, h: number) => {
    const r = Math.min(4, barW / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${y + h}Z`;
  };

  const hv = hover !== null ? data[hover] : null;
  const hx = hover !== null ? pad.l + hover * band + band / 2 : 0;
  const hy = hv ? pad.t + plotH - (hv[metric] / max) * plotH : 0;

  return (
    <div className="chart-wrap" ref={ref}>
      <svg width={w} height={H} role="img" aria-label={`Daily ${metric === 'costUsd' ? 'cost' : 'tokens'}`} style={{ display: 'block' }}>
        {ticks.map((t) => {
          const y = pad.t + plotH - (t / max) * plotH;
          return (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y} y2={y} stroke={t === 0 ? 'var(--axis)' : 'var(--hairline)'} strokeWidth={1} />
              <text x={pad.l - 8} y={y} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmt(metric, t)}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const v = d[metric];
          const h = (v / max) * plotH;
          const x = pad.l + i * band + (band - barW) / 2;
          const y = pad.t + plotH - h;
          return (
            <g key={d.key}>
              {h > 0 && <path d={bar(x, y, h)} fill="var(--series-1)" opacity={hover === null || hover === i ? 1 : 0.55} />}
              {i % every === 0 && (
                <text x={pad.l + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {label(d.key)}
                </text>
              )}
              <rect
                x={pad.l + i * band}
                y={pad.t}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${label(d.key)}: ${fmt(metric, v)}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                style={{ outline: 'none' }}
              />
            </g>
          );
        })}
      </svg>
      {hv && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(hx, 80), w - 80), top: hy }}>
          <strong>{fmt(metric, hv[metric])}</strong>
          <span className="muted">
            <span className="key" />
            {label(hv.key)} · {hv.turns} turn{hv.turns === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </div>
  );
}

function BarList({ rows, metric, empty }: { rows: Group[]; metric: Metric; empty: string }) {
  if (!rows.length) return <Empty title={empty} />;
  const max = Math.max(...rows.map((r) => r[metric]), 0) || 1;
  return (
    <div>
      {rows.slice(0, 10).map((r) => (
        <div key={r.key} className="hbar" tabIndex={0} title={`${r.key}: ${fmt(metric, r[metric])} · ${r.turns} turns`}>
          <span className="small truncate">{r.key}</span>
          <div className="track">
            {r[metric] > 0 && <div className="fill" style={{ width: `${(r[metric] / max) * 100}%` }} />}
          </div>
          <span className="small right" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(metric, r[metric])}</span>
        </div>
      ))}
    </div>
  );
}

export function Usage() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [metric, setMetric] = useState<Metric>('costUsd');
  const [asTable, setAsTable] = useState(false);
  const q = useQuery({ queryKey: ['usage', days], queryFn: () => api.get<Summary>(`/usage/summary?days=${days}`), placeholderData: (prev) => prev });
  const s = q.data;
  const pct = s && s.month.budgetUsd > 0 ? (s.month.spentUsd / s.month.budgetUsd) * 100 : 0;
  const cacheShare = s && s.totals.inputTokens + s.totals.cacheReadTokens > 0 ? (s.totals.cacheReadTokens / (s.totals.inputTokens + s.totals.cacheReadTokens)) * 100 : 0;

  return (
    <div className="stack lg">
      <PageHead title="Cost & usage" sub="Every model turn is metered. Stage, run and monthly budgets are hard gates: a run stops the moment one is exhausted." />
      <div className="row">
        <Seg options={[{ id: '7', label: 'Last 7 days' }, { id: '30', label: 'Last 30 days' }, { id: '90', label: 'Last 90 days' }]} value={days} onChange={setDays} />
        <Seg options={[{ id: 'costUsd', label: 'Cost' }, { id: 'tokens', label: 'Tokens' }]} value={metric} onChange={setMetric} />
      </div>
      {!s ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="stack lg" style={{ opacity: q.isFetching ? 0.6 : 1, transition: 'opacity .15s' }}>
          <div className="grid cols-2" style={{ alignItems: 'stretch' }}>
            <div className="card card-pad">
              <div className="label">Spend this month</div>
              <div className="hero">{usd(s.month.spentUsd)}</div>
              <div className={`meter ${pct >= 100 ? 'critical' : pct >= 80 ? 'warning' : ''}`} style={{ marginTop: 12 }} aria-label={`${pct.toFixed(0)}% of monthly budget`}>
                <span style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <div className="small ink-2" style={{ marginTop: 6 }}>
                {s.month.budgetUsd > 0 ? `${pct.toFixed(0)}% of the ${usd(s.month.budgetUsd)} monthly budget — runs stop when it is reached.` : 'No monthly budget set.'}{' '}
                <Link to="/settings">Change</Link>
              </div>
            </div>
            <div className="grid cols-2">
              <div className="card stat"><div className="label">Spend in range</div><div className="value">{usd(s.totals.costUsd)}</div><div className="sub">last {s.days} days</div></div>
              <div className="card stat"><div className="label">Tokens</div><div className="value">{compact(s.totals.tokens)}</div><div className="sub">{compact(s.totals.outputTokens)} output</div></div>
              <div className="card stat"><div className="label">Model turns</div><div className="value">{s.totals.turns.toLocaleString()}</div><div className="sub">across {s.totals.runs} run{s.totals.runs === 1 ? '' : 's'}</div></div>
              <div className="card stat"><div className="label">Prompt cache reads</div><div className="value">{cacheShare.toFixed(0)}%</div><div className="sub">of input tokens served from cache</div></div>
            </div>
          </div>

          <Card title={metric === 'costUsd' ? 'Daily cost' : 'Daily tokens'} actions={<Seg options={[{ id: 'chart', label: 'Chart' }, { id: 'table', label: 'Table' }]} value={asTable ? 'table' : 'chart'} onChange={(v) => setAsTable(v === 'table')} />}>
            {asTable ? (
              <table className="table">
                <thead><tr><th>Day</th><th className="num">Cost</th><th className="num">Tokens</th><th className="num">Turns</th></tr></thead>
                <tbody>
                  {s.byDay.filter((d) => d.turns > 0).map((d) => (
                    <tr key={d.key}><td>{d.key}</td><td className="num">{usd(d.costUsd)}</td><td className="num">{d.tokens.toLocaleString()}</td><td className="num">{d.turns}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <ColumnChart data={s.byDay} metric={metric} />
            )}
          </Card>

          <div className="grid cols-3">
            <Card title="By operation"><BarList rows={s.byOperation} metric={metric} empty="No usage" /></Card>
            <Card title="By model"><BarList rows={s.byModel} metric={metric} empty="No usage" /></Card>
            <Card title="By repository"><BarList rows={s.byRepo} metric={metric} empty="No usage" /></Card>
          </div>

          <Card title="Most expensive runs" pad={false}>
            {s.topRuns.length ? (
              <table className="table">
                <thead><tr><th>Run</th><th>Status</th><th className="num">Cost</th><th className="num">Tokens</th><th className="num">Turns</th></tr></thead>
                <tbody>
                  {s.topRuns.map((r) => (
                    <tr key={r.key}>
                      <td><Link to={`/runs/${r.key}`}>{r.title}</Link><div className="tiny muted">{r.repoName}</div></td>
                      <td>{r.status !== 'unknown' && <StatusPill status={r.status} />}</td>
                      <td className="num">{usd(r.costUsd)}</td>
                      <td className="num">{r.tokens.toLocaleString()}</td>
                      <td className="num">{r.turns}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty title="No runs in this period" />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
