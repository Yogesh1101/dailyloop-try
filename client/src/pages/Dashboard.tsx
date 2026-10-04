import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Settings } from '@harness/shared';
import { ago, api, usd, type Run } from '../api';
import { Card, Empty, PageHead, StageDots, StatusPill } from '../components/ui';

interface Stats {
  repos: number;
  pipelines: number;
  operations: number;
  skills: number;
  active: number;
  awaiting: number;
  blocked: number;
  monthSpend: number;
  settings: Settings;
}

export function RunTable({ runs, empty }: { runs: Run[]; empty?: string }) {
  const nav = useNavigate();
  if (!runs.length) return <Empty title={empty ?? 'No runs yet'} />;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Run</th>
          <th>Status</th>
          <th>Stages</th>
          <th>Pipeline</th>
          <th className="num">Cost</th>
          <th className="num">Updated</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r._id} className="click" onClick={() => nav(`/runs/${r._id}`)}>
            <td style={{ maxWidth: 380 }}>
              <div className="truncate" style={{ fontWeight: 550 }}>{r.title}</div>
              <div className="tiny muted truncate">
                {r.repoName}
                {r.statusMessage ? ` · ${r.statusMessage}` : ''}
              </div>
            </td>
            <td>
              <StatusPill status={r.status} scheduled={!!r.scheduledFor && new Date(r.scheduledFor) > new Date()} />
            </td>
            <td>
              <StageDots stages={r.stages} />
            </td>
            <td className="small ink-2">{r.pipeline.name}</td>
            <td className="num">{usd(r.usage?.costUsd)}</td>
            <td className="num small muted">{ago(r.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Dashboard() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api.get<Stats>('/stats') });
  const runs = useQuery({ queryKey: ['runs', 'recent'], queryFn: () => api.runs('?limit=12') });
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: api.approvals });
  const s = stats.data;
  const budget = s?.settings.monthlyBudgetUsd ?? 0;
  const pct = budget > 0 ? Math.min(100, ((s?.monthSpend ?? 0) / budget) * 100) : 0;
  const tonight = (runs.data ?? []).filter((r) => r.status === 'queued' && r.scheduledFor && new Date(r.scheduledFor) > new Date());
  const blocked = (runs.data ?? []).filter((r) => r.status === 'blocked' || r.status === 'error');

  return (
    <div className="stack lg">
      <PageHead
        title="Dashboard"
        sub="Humans set direction and review at the gates; agents execute between them. Approve during the day, let the plan run overnight, review in the morning."
        actions={
          <Link className="btn primary" to="/runs/new">
            Start a run
          </Link>
        }
      />

      {s && s.repos === 0 && (
        <div className="callout info">
          <h3>Get started</h3>
          <p className="small">
            1. <Link to="/repos">Add a repository</Link> and configure its checks (test, lint…). 2. Review the built-in <Link to="/pipelines">pipelines</Link> and{' '}
            <Link to="/operations">operations</Link>. 3. <Link to="/runs/new">Start a run</Link> — use the <code>mock</code> provider to try the gates without an API key.
          </p>
        </div>
      )}

      <div className="grid cols-4">
        <div className="card stat">
          <div className="label">Awaiting your approval</div>
          <div className="value">{s?.awaiting ?? '—'}</div>
          <div className="sub">
            <Link to="/approvals">Open the inbox</Link>
          </div>
        </div>
        <div className="card stat">
          <div className="label">Running or queued</div>
          <div className="value">{s?.active ?? '—'}</div>
          <div className="sub">{tonight.length ? `${tonight.length} scheduled for later` : 'Nothing scheduled'}</div>
        </div>
        <div className="card stat">
          <div className="label">Blocked — needs a human</div>
          <div className="value">{s?.blocked ?? '—'}</div>
          <div className="sub">Gate failures and policy violations</div>
        </div>
        <div className="card stat">
          <div className="label">Spend this month</div>
          <div className="value">{usd(s?.monthSpend)}</div>
          <div className={`meter ${pct >= 100 ? 'critical' : pct >= 80 ? 'warning' : ''}`} style={{ marginTop: 8 }} aria-label={`${pct.toFixed(0)}% of budget`}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="sub">{budget > 0 ? `${pct.toFixed(0)}% of ${usd(budget)} budget` : 'No monthly budget set'}</div>
        </div>
      </div>

      <div className="grid cols-2">
        <Card title="Approval inbox" sub="Stages that passed every automated gate and wait for a human" pad={false}>
          {approvals.data?.length ? (
            <table className="table">
              <tbody>
                {approvals.data.slice(0, 6).map((r) => (
                  <tr key={r._id}>
                    <td>
                      <Link to={`/runs/${r._id}`} style={{ fontWeight: 550 }}>
                        {r.title}
                      </Link>
                      <div className="tiny muted">
                        {r.stages[r.currentStage]?.name} · {r.repoName}
                      </div>
                    </td>
                    <td className="num small muted">{ago(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="Inbox zero">Nothing is waiting for you.</Empty>
          )}
        </Card>
        <Card title="Needs attention" sub="Blocked by a gate, a budget or a policy violation" pad={false}>
          {blocked.length ? (
            <table className="table">
              <tbody>
                {blocked.slice(0, 6).map((r) => (
                  <tr key={r._id}>
                    <td>
                      <Link to={`/runs/${r._id}`} style={{ fontWeight: 550 }}>
                        {r.title}
                      </Link>
                      <div className="tiny muted truncate" style={{ maxWidth: 440 }}>
                        {r.statusMessage}
                      </div>
                    </td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="All clear">No blocked runs.</Empty>
          )}
        </Card>
      </div>

      <Card title="Recent runs" actions={<Link to="/runs" className="btn sm">All runs</Link>} pad={false}>
        <RunTable runs={runs.data ?? []} empty="No runs yet — start one to see the gates in action." />
      </Card>
    </div>
  );
}
