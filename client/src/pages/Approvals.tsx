import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ago, api } from '../api';
import { Card, Empty, PageHead } from '../components/ui';

export function Approvals() {
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: api.approvals });
  return (
    <div className="stack lg">
      <PageHead
        title="Approvals"
        sub="Each item passed every automated gate. Review the artifacts and the diff, tick the checklist, then approve, reject with feedback, or send the work back."
      />
      <Card pad={false}>
        {approvals.data?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Stage waiting</th>
                <th>Repository</th>
                <th className="num">Waiting since</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {approvals.data.map((r) => {
                const st = r.stages[r.currentStage];
                return (
                  <tr key={r._id}>
                    <td style={{ fontWeight: 550 }}>{r.title}</td>
                    <td>
                      <span className="pill warning">✋ {st?.name}</span>
                    </td>
                    <td className="small ink-2">{r.repoName}</td>
                    <td className="num small muted">{ago(r.updatedAt)}</td>
                    <td className="right">
                      <Link className="btn sm primary" to={`/runs/${r._id}`}>
                        Review
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty title="Nothing to review">Runs pause here whenever a stage reaches a human gate.</Empty>
        )}
      </Card>
    </div>
  );
}
