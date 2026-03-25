import { useEffect, useState } from 'react';
import {
  Key,
  ShieldCheck,
  GitPullRequestArrow,
  AlertTriangle,
  Activity,
  ShieldPlus,
  Copy,
} from 'lucide-react';
import clsx from 'clsx';
import { tokens as tokensApi, tokenRequests, services, logs, type LogEntry, type Service } from '../lib/api';
import { Modal } from '../components/Modal';
import { useNotification } from '../components/Notification';

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ElementType;
  accent?: 'brand' | 'emerald' | 'amber' | 'red';
}

const accentClasses = {
  brand: 'bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400',
  emerald:
    'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
  red: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
};

function StatCard({ label, value, icon: Icon, accent = 'brand' }: StatCardProps) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-4">
        <div
          className={clsx(
            'flex items-center justify-center h-10 w-10 rounded-lg',
            accentClasses[accent],
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-2xl font-bold text-slate-900 dark:text-zinc-100 tabular-nums">
            {value}
          </p>
          <p className="text-sm text-slate-500 dark:text-zinc-500">{label}</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function Dashboard() {
  const { notify } = useNotification();
  const [captureToken, setCaptureToken] = useState<{ preview: string; service: string; tokenId: string } | null>(null);
  const [captureName, setCaptureName] = useState('');
  const [captureProvider, setCaptureProvider] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [capturedFake, setCapturedFake] = useState<string | null>(null);

  const handleCapture = async () => {
    if (!captureName.trim() || !captureToken) return;
    setCapturing(true);
    try {
      const result = await tokensApi.capture({ name: captureName, provider: captureProvider || undefined, tokenId: captureToken.tokenId });
      setCapturedFake(result.fakeToken);
      notify('success', 'Token captured!');
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to capture token.');
    } finally {
      setCapturing(false);
    }
  };

  const closeCaptureModal = () => { setCaptureToken(null); setCaptureName(''); setCaptureProvider(''); setCapturedFake(null); };
  const [totalTokens, setTotalTokens] = useState(0);
  const [activeTokens, setActiveTokens] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [warningServices, setWarningServices] = useState<Service[]>([]);
  const [recentLogs, setRecentLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [tokRes, reqRes, svcRes, logRes] = await Promise.allSettled([
          tokensApi.list(),
          tokenRequests.list(),
          services.list(),
          logs.query({ limit: 10 }),
        ]);

        if (cancelled) return;

        if (tokRes.status === 'fulfilled') {
          const toks = tokRes.value.tokens ?? [];
          setTotalTokens(toks.length);
          setActiveTokens(toks.filter((t: any) => !t.revoked).length);
        }
        if (reqRes.status === 'fulfilled') {
          const reqs = reqRes.value.requests ?? [];
          setPendingCount(
            reqs.filter((r: any) => r.status === 'pending').length,
          );
        }
        if (svcRes.status === 'fulfilled') {
          setWarningServices(svcRes.value.services ?? []);
        }
        if (logRes.status === 'fulfilled') {
          const val = logRes.value as any;
          setRecentLogs(val.logs ?? []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">
          Dashboard
        </h1>
        <p className="text-sm text-slate-500 dark:text-zinc-500 mt-1">
          Overview of your Overbearer deployment.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total Tokens"
          value={loading ? '--' : totalTokens}
          icon={Key}
          accent="brand"
        />
        <StatCard
          label="Active Tokens"
          value={loading ? '--' : activeTokens}
          icon={ShieldCheck}
          accent="emerald"
        />
        <StatCard
          label="Pending Requests"
          value={loading ? '--' : pendingCount}
          icon={GitPullRequestArrow}
          accent="amber"
        />
        <StatCard
          label="Services with Warnings"
          value={loading ? '--' : warningServices.length}
          icon={AlertTriangle}
          accent={warningServices.length > 0 ? 'red' : 'brand'}
        />
      </div>

      {/* Direct token usage */}
      {warningServices.length > 0 && (
        <div className="card border-red-200 dark:border-red-800">
          <div className="flex items-center gap-3 border-b border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-500/10 px-5 py-3 rounded-t-xl">
            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
            <h2 className="text-sm font-semibold text-red-800 dark:text-red-300">
              Unprotected services detected in the last 24 hours
            </h2>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-zinc-800/60">
            {warningServices.map((svc: any) => (
              <div key={svc.name} className="px-5 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-zinc-100 truncate">
                    {svc.name}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-zinc-500">
                    {svc.requestCount ?? svc.warningCount ?? 0} requests
                    {svc.distinctTokens ? ` · ${svc.distinctTokens} token${svc.distinctTokens > 1 ? 's' : ''}` : ''}
                    {svc.forbiddenCount > 0 && (
                      <span className="text-red-600 dark:text-red-400"> · {svc.forbiddenCount} rejected</span>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(svc.tokenPreviews ?? []).filter(Boolean).slice(0, 3).map((t: string, i: number) => (
                    <button
                      key={i}
                      onClick={() => {
                        setCaptureToken({ preview: t, service: svc.name, tokenId: (svc as any).tokenIds?.[i] ?? '' });
                        setCaptureName(`${svc.name} API Key`);
                      }}
                      className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 rounded hover:ring-2 hover:ring-red-300 dark:hover:ring-red-600 transition-shadow"
                      title="Capture this token"
                    >
                      {t}
                      <ShieldPlus className="h-2.5 w-2.5" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity */}
      <div className="card">
        <div className="flex items-center gap-2 border-b border-slate-200 dark:border-zinc-800 px-5 py-4">
          <Activity className="h-5 w-5 text-slate-400 dark:text-zinc-500" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            Recent Activity
          </h2>
        </div>
        {loading ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-4 rounded bg-slate-100 dark:bg-zinc-800 animate-pulse" />
            ))}
          </div>
        ) : recentLogs.length === 0 ? (
          <p className="p-5 text-sm text-slate-400 dark:text-zinc-500">
            No recent activity recorded.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-zinc-800/60">
            {recentLogs.map((log) => (
              <li
                key={`${log.timestamp}-${log.targetHost}-${log.path}`}
                className="flex items-center gap-4 px-5 py-3 text-sm"
              >
                <span
                  className={clsx(
                    'inline-block h-2 w-2 rounded-full flex-shrink-0',
                    log.tokenType === 'fake' && 'bg-emerald-500',
                    log.tokenType === 'real_direct' && 'bg-red-500',
                    log.tokenType === 'unknown' && 'bg-slate-400 dark:bg-zinc-600',
                  )}
                />
                <span className="font-medium text-slate-700 dark:text-zinc-300 w-24 truncate">
                  {log.service}
                </span>
                <span className="font-mono text-xs text-slate-500 dark:text-zinc-500 flex-1 truncate">
                  {log.method} {log.path}
                </span>
                <span className="text-xs text-slate-400 dark:text-zinc-600 tabular-nums">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Capture Modal */}
      <Modal
        open={captureToken !== null}
        onClose={closeCaptureModal}
        title="Capture Token"
        size="md"
        actions={capturedFake ? (
          <button className="btn-primary" onClick={closeCaptureModal}>Done</button>
        ) : (
          <>
            <button className="btn-secondary" onClick={closeCaptureModal} disabled={capturing}>Cancel</button>
            <button className="btn-primary" onClick={handleCapture} disabled={capturing || !captureName.trim()}>
              {capturing ? 'Capturing...' : 'Capture & Generate Fake'}
            </button>
          </>
        )}
      >
        {capturedFake ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-zinc-400">
              Token captured. Send this fake token to the owner of <strong>{captureToken?.service}</strong>:
            </p>
            <div className="relative">
              <code className="block w-full rounded-lg bg-slate-100 dark:bg-zinc-800 p-3 text-xs font-mono text-slate-800 dark:text-zinc-200 break-all select-all">{capturedFake}</code>
              <button onClick={() => { navigator.clipboard.writeText(capturedFake); notify('success', 'Copied.'); }} className="absolute top-2 right-2 btn-ghost p-1.5 rounded-md" title="Copy">
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-zinc-400">
              Capture token <code className="text-xs font-mono bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 px-1.5 py-0.5 rounded">{captureToken?.preview}</code> from <strong>{captureToken?.service}</strong> and generate a safe replacement.
            </p>
            <div>
              <label className="label">Name</label>
              <input className="input" value={captureName} onChange={(e) => setCaptureName(e.target.value)} />
            </div>
            <div>
              <label className="label">Provider <span className="text-slate-400 dark:text-zinc-600 font-normal">(optional)</span></label>
              <input className="input" value={captureProvider} onChange={(e) => setCaptureProvider(e.target.value)} placeholder="e.g. anthropic" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
