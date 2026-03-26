import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Hash, CheckCircle, Clock, Users } from 'lucide-react';
import clsx from 'clsx';
import { services as svcApi, NewAssociation } from '../lib/api';

/** Returns a human-readable relative time string like "5 minutes ago". */
function timeAgo(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function NewActivity() {
  const navigate = useNavigate();
  const [data, setData] = useState<NewAssociation[]>([]);
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await svcApi.newAssociations();
      setData(res.newAssociations ?? []);
      setHours(res.hours ?? 24);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">
          New Activity
        </h1>
        <p className="text-sm text-slate-500 dark:text-zinc-500 mt-1">
          Services that started using a token they haven't used before. Review
          these to confirm they are expected.
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card h-32 animate-pulse bg-slate-100 dark:bg-zinc-800" />
          ))}
        </div>
      ) : data.length === 0 ? (
        <div className="card p-8 text-center">
          <CheckCircle className="h-8 w-8 text-emerald-500 dark:text-emerald-400 mx-auto mb-3" />
          <p className="text-sm text-slate-500 dark:text-zinc-500">
            No new service-token associations detected in the last {hours} hours. All clear.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.map((assoc) => (
            <div
              key={`${assoc.serviceName}-${assoc.tokenId}`}
              className="card bg-amber-50 dark:bg-amber-500/10 hover:ring-2 hover:ring-amber-300 dark:hover:ring-amber-700 transition-shadow cursor-pointer"
              onClick={() =>
                navigate(
                  `/logs?service_name=${encodeURIComponent(assoc.serviceName)}&token_type=fake`,
                )
              }
            >
              <div className="p-5">
                <div className="flex items-start gap-3">
                  <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-amber-50 dark:bg-amber-500/10">
                    <Search className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                      {assoc.serviceName}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-zinc-500 mt-0.5">
                      Using token <span className="font-medium text-slate-700 dark:text-zinc-300">{assoc.tokenName}</span>
                      {assoc.provider && (
                        <span className="text-slate-400 dark:text-zinc-600"> ({assoc.provider})</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-zinc-500 flex items-center gap-1 mt-1">
                      <Clock className="h-3 w-3" />
                      First seen {timeAgo(assoc.firstSeen)}
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <div className="flex items-center gap-2 text-sm">
                    <Hash className="h-4 w-4 text-slate-400 dark:text-zinc-500" />
                    <div>
                      <p className="font-semibold text-slate-900 dark:text-zinc-100 tabular-nums">
                        {assoc.requestCount}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-zinc-500">
                        Requests since first seen
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Users className="h-4 w-4 text-slate-400 dark:text-zinc-500" />
                    <div>
                      <p className="font-semibold text-slate-900 dark:text-zinc-100 tabular-nums">
                        {assoc.knownServiceCount}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-zinc-500">
                        Known services for this token
                      </p>
                    </div>
                  </div>
                </div>

                {assoc.knownServices.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-amber-200/60 dark:border-amber-700/30">
                    <p className="text-xs text-slate-500 dark:text-zinc-500 mb-1.5">
                      This token is normally used by {assoc.knownServiceCount} service{assoc.knownServiceCount === 1 ? '' : 's'}:
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {assoc.knownServices.map((name) => (
                        <span
                          key={name}
                          className="inline-block px-2 py-0.5 text-xs font-mono bg-white/60 dark:bg-zinc-800/60 text-slate-600 dark:text-zinc-400 rounded"
                        >
                          {name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {assoc.knownServiceCount >= 3 && (
                  <p className={clsx(
                    'mt-3 text-xs italic',
                    'text-amber-700 dark:text-amber-400/80',
                  )}>
                    New service for a widely-used token — worth a quick check
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
