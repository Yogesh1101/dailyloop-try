import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Card, PageHead, Seg } from '../components/ui';
import { RunTable } from './Dashboard';

const FILTERS = {
  all: '',
  active: 'queued,running',
  awaiting: 'awaiting_approval',
  blocked: 'blocked,error',
  done: 'completed,cancelled',
} as const;

export function Runs() {
  const [filter, setFilter] = useState<keyof typeof FILTERS>('all');
  const q = FILTERS[filter] ? `?status=${FILTERS[filter]}` : '';
  const runs = useQuery({ queryKey: ['runs', filter], queryFn: () => api.runs(q) });
  return (
    <div className="stack lg">
      <PageHead
        title="Runs"
        sub="Every run freezes its pipeline, operations and skills at creation, works on its own branch in an isolated worktree, and records every tool call and gate result."
        actions={<Link className="btn primary" to="/runs/new">New run</Link>}
      />
      <Seg
        options={[
          { id: 'all', label: 'All' },
          { id: 'active', label: 'Active' },
          { id: 'awaiting', label: 'Awaiting approval' },
          { id: 'blocked', label: 'Blocked' },
          { id: 'done', label: 'Finished' },
        ]}
        value={filter}
        onChange={setFilter}
      />
      <Card pad={false}>
        <RunTable runs={runs.data ?? []} />
      </Card>
    </div>
  );
}
