import { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw, Filter } from 'lucide-react';
import clsx from 'clsx';
import { logs, type LogEntry, type LogQueryParams } from '../lib/api';
import { DataTable, type Column } from '../components/DataTable';

// ---------------------------------------------------------------------------
// Token type badge
// ---------------------------------------------------------------------------

function TokenTypeBadge({ type }: { type: LogEntry['tokenType'] }) {
  const styles = {
    fake: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20',
    real_direct:
      'bg-red-50 text-red-700 ring-red-600/10 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20',
    unknown:
      'bg-slate-100 text-slate-600 ring-slate-500/10 dark:bg-zinc-700/40 dark:text-zinc-400 dark:ring-zinc-500/20',
  };

  const labels = {
    fake: 'Fake',
    real_direct: 'Real (Direct)',
    unknown: 'Unknown',
  };

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        styles[type],
      )}
    >
      {labels[type]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Logs page
// ---------------------------------------------------------------------------

export function Logs() {
  const [data, setData] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  // Filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [service, setService] = useState('');
  const [targetHost, setTargetHost] = useState('');
  const [tokenType, setTokenType] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const pageSize = 25;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: LogQueryParams = {
        page,
        limit: pageSize,
      };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      if (service) params.service = service;
      if (targetHost) params.targetHost = targetHost;
      if (tokenType) params.tokenType = tokenType;

      const res = await logs.query(params) as any;
      setData(res.logs ?? res.data ?? []);
      setTotal(res.total ?? 0);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [page, startDate, endDate, service, targetHost, tokenType]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh handling
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(load, 5000);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh, load]);

  const columns: Column<LogEntry>[] = [
    {
      key: 'timestamp',
      header: 'Timestamp',
      sortable: true,
      render: (l) => (
        <span className="text-xs tabular-nums">
          {new Date(l.timestamp).toLocaleString()}
        </span>
      ),
    },
    { key: 'service', header: 'Service', sortable: true },
    {
      key: 'targetHost',
      header: 'Target Host',
      sortable: true,
      render: (l) => (
        <span className="font-mono text-xs">{l.targetHost}</span>
      ),
    },
    {
      key: 'method',
      header: 'Method',
      render: (l) => (
        <span className="font-mono text-xs font-semibold">{l.method}</span>
      ),
    },
    {
      key: 'path',
      header: 'Path',
      render: (l) => (
        <span
          className="font-mono text-xs max-w-[200px] truncate block"
          title={l.path}
        >
          {l.path}
        </span>
      ),
    },
    {
      key: 'tokenType',
      header: 'Token Type',
      sortable: true,
      render: (l) => <TokenTypeBadge type={l.tokenType} />,
    },
    {
      key: 'statusCode',
      header: 'Status',
      sortable: true,
      render: (l) => (
        <span
          className={clsx(
            'font-mono text-xs font-semibold tabular-nums',
            l.statusCode < 300 && 'text-emerald-600 dark:text-emerald-400',
            l.statusCode >= 300 &&
              l.statusCode < 500 &&
              'text-amber-600 dark:text-amber-400',
            l.statusCode >= 500 && 'text-red-600 dark:text-red-400',
          )}
        >
          {l.statusCode}
        </span>
      ),
    },
    {
      key: 'latencyMs',
      header: 'Latency',
      sortable: true,
      render: (l) => (
        <span className="text-xs tabular-nums text-slate-500 dark:text-zinc-500">
          {l.latencyMs}ms
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">
            Logs
          </h1>
          <p className="text-sm text-slate-500 dark:text-zinc-500 mt-1">
            Proxy request log viewer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Auto-refresh toggle */}
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-slate-300 dark:border-zinc-700 text-brand-600 focus:ring-brand-500/40"
            />
            Auto-refresh
          </label>
          <button
            className="btn-ghost p-2 rounded-lg"
            onClick={load}
            title="Refresh"
          >
            <RefreshCw className={clsx('h-4 w-4', loading && 'animate-spin')} />
          </button>
          <button
            className={clsx(
              'btn-secondary',
              showFilters && 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-400 border-brand-300 dark:border-brand-700',
            )}
            onClick={() => setShowFilters((v) => !v)}
          >
            <Filter className="h-4 w-4" />
            Filters
          </button>
        </div>
      </div>

      {/* Filters panel */}
      {showFilters && (
        <div className="card p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label className="label">Start Date</label>
              <input
                type="datetime-local"
                className="input"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div>
              <label className="label">End Date</label>
              <input
                type="datetime-local"
                className="input"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div>
              <label className="label">Service</label>
              <input
                className="input"
                placeholder="Service name..."
                value={service}
                onChange={(e) => {
                  setService(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div>
              <label className="label">Target Host</label>
              <input
                className="input"
                placeholder="api.example.com"
                value={targetHost}
                onChange={(e) => {
                  setTargetHost(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div>
              <label className="label">Token Type</label>
              <select
                className="input"
                value={tokenType}
                onChange={(e) => {
                  setTokenType(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All</option>
                <option value="fake">Fake</option>
                <option value="real_direct">Real (Direct)</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        data={data}
        rowKey={(l) => `${l.timestamp}-${l.targetHost}-${l.path}`}
        loading={loading}
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        emptyMessage="No log entries found."
      />
    </div>
  );
}
