import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useLiveRuns, useTheme } from './hooks';
import { Dashboard } from './pages/Dashboard';
import { Runs } from './pages/Runs';
import { NewRun } from './pages/NewRun';
import { RunDetail } from './pages/RunDetail';
import { Approvals } from './pages/Approvals';
import { Repos, RepoDetail } from './pages/Repos';
import { Pipelines, PipelineEdit } from './pages/Pipelines';
import { Operations, OperationEdit } from './pages/Operations';
import { Skills } from './pages/Skills';
import { Knowledge } from './pages/Knowledge';
import { Schedules } from './pages/Schedules';
import { Usage } from './pages/Usage';
import { ExportPage } from './pages/Export';
import { SettingsPage } from './pages/Settings';
import { Seg } from './components/ui';

function Nav() {
  const { data: approvals } = useQuery({ queryKey: ['approvals'], queryFn: api.approvals, refetchInterval: 30_000 });
  const link = (to: string, label: string, extra?: React.ReactNode) => (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
      {label}
      {extra}
    </NavLink>
  );
  return (
    <nav className="nav">
      <div className="nav-group">Deliver</div>
      {link('/', 'Dashboard')}
      {link('/approvals', 'Approvals', approvals?.length ? <span className="count">{approvals.length}</span> : null)}
      {link('/runs', 'Runs')}
      {link('/schedules', 'Schedules')}
      <div className="nav-group">Configure</div>
      {link('/repos', 'Repositories')}
      {link('/pipelines', 'Pipelines')}
      {link('/operations', 'Operations')}
      {link('/skills', 'Skills')}
      {link('/knowledge', 'Knowledge')}
      <div className="nav-group">Govern</div>
      {link('/usage', 'Cost & usage')}
      {link('/export', 'Export')}
      {link('/settings', 'Settings')}
    </nav>
  );
}

export function App() {
  useLiveRuns();
  const [initial, applyTheme] = useTheme();
  const [theme, setTheme] = useState(initial);
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AH</div>
          <div>
            <div className="brand-name">Agentic Harness</div>
            <div className="brand-sub">Gated agentic delivery</div>
          </div>
        </div>
        <Nav />
        <div className="sidebar-foot">
          <span className="tiny muted">Theme</span>
          <Seg
            options={[
              { id: 'system', label: 'Auto' },
              { id: 'light', label: 'Light' },
              { id: 'dark', label: 'Dark' },
            ]}
            value={theme}
            onChange={(t) => {
              setTheme(t);
              applyTheme(t);
            }}
          />
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/new" element={<NewRun />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/repos" element={<Repos />} />
          <Route path="/repos/:id" element={<RepoDetail />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/pipelines/:id" element={<PipelineEdit />} />
          <Route path="/operations" element={<Operations />} />
          <Route path="/operations/:id" element={<OperationEdit />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/export" element={<ExportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<div className="empty"><h3>Page not found</h3></div>} />
        </Routes>
      </main>
    </div>
  );
}
