import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Ban, Clock, Key, Hash, ShieldPlus, Copy } from 'lucide-react';
import clsx from 'clsx';
import { services as svcApi, tokens } from '../lib/api';
import { Modal } from '../components/Modal';
import { useNotification } from '../components/Notification';

interface ServiceEntry {
  name: string;
  requestCount: number;
  distinctTokens: number;
  lastSeenAt: string;
  forbiddenCount: number;
  tokenPreviews: string[];
  tokenIds: string[];
}

export function Services() {
  const navigate = useNavigate();
  const { notify } = useNotification();
  const [data, setData] = useState<ServiceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [captureToken, setCaptureToken] = useState<{ preview: string; service: string; tokenId: string } | null>(null);
  const [captureName, setCaptureName] = useState('');
  const [captureProvider, setCaptureProvider] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [capturedFake, setCapturedFake] = useState<string | null>(null);

  const handleCapture = async () => {
    if (!captureName.trim() || !captureToken) return;
    setCapturing(true);
    try {
      const result = await tokens.capture({
        name: captureName,
        provider: captureProvider || undefined,
        tokenId: captureToken.tokenId,
      });
      setCapturedFake(result.fakeToken);
      notify('success', `Token captured! Send the fake token to the service owner.`);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to capture token.');
    } finally {
      setCapturing(false);
    }
  };

  const closeCaptureModal = () => {
    setCaptureToken(null);
    setCaptureName('');
    setCaptureProvider('');
    setCapturedFake(null);
  };

  const load = useCallback(async () => {
    try {
      const res = await svcApi.list() as any;
      setData(res.services ?? []);
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
          Services
        </h1>
        <p className="text-sm text-slate-500 dark:text-zinc-500 mt-1">
          Services detected using API tokens directly in the last 24 hours.
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card h-24 animate-pulse bg-slate-100 dark:bg-zinc-800" />
          ))}
        </div>
      ) : data.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-slate-500 dark:text-zinc-500">
            No services detected using tokens directly. All clear.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.map((svc) => (
            <div
              key={svc.name}
              className="card hover:ring-2 hover:ring-red-300 dark:hover:ring-red-700 transition-shadow cursor-pointer"
              onClick={() => navigate(`/logs?service_name=${encodeURIComponent(svc.name)}&token_type=real_direct`)}
            >
              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-red-50 dark:bg-red-500/10">
                      <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                        {svc.name}
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-zinc-500 flex items-center gap-1 mt-0.5">
                        <Clock className="h-3 w-3" />
                        Last seen {new Date(svc.lastSeenAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="flex items-center gap-2 text-sm">
                    <Hash className="h-4 w-4 text-slate-400 dark:text-zinc-500" />
                    <div>
                      <p className="font-semibold text-slate-900 dark:text-zinc-100 tabular-nums">{svc.requestCount}</p>
                      <p className="text-xs text-slate-500 dark:text-zinc-500">Requests</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Key className="h-4 w-4 text-slate-400 dark:text-zinc-500" />
                    <div>
                      <p className="font-semibold text-slate-900 dark:text-zinc-100 tabular-nums">{svc.distinctTokens}</p>
                      <p className="text-xs text-slate-500 dark:text-zinc-500">Distinct tokens</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Ban className="h-4 w-4 text-slate-400 dark:text-zinc-500" />
                    <div>
                      <p className={clsx(
                        'font-semibold tabular-nums',
                        svc.forbiddenCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-zinc-100',
                      )}>
                        {svc.forbiddenCount}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-zinc-500">403 errors</p>
                    </div>
                  </div>
                </div>

                {svc.tokenPreviews.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-slate-100 dark:border-zinc-800">
                    <p className="text-xs text-slate-500 dark:text-zinc-500 mb-2">Tokens observed:</p>
                    <div className="flex flex-wrap gap-2">
                      {svc.tokenPreviews.filter(Boolean).map((preview, i) => (
                        <button
                          key={i}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCaptureToken({ preview, service: svc.name, tokenId: svc.tokenIds?.[i] ?? '' });
                            setCaptureName(`${svc.name} API Key`);
                          }}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 rounded hover:ring-2 hover:ring-red-300 dark:hover:ring-red-600 transition-shadow"
                          title="Capture this token"
                        >
                          {preview}
                          <ShieldPlus className="h-3 w-3" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Capture Token Modal */}
      <Modal
        open={captureToken !== null}
        onClose={closeCaptureModal}
        title="Capture Token"
        size="md"
        actions={
          capturedFake ? (
            <button className="btn-primary" onClick={closeCaptureModal}>Done</button>
          ) : (
            <>
              <button className="btn-secondary" onClick={closeCaptureModal} disabled={capturing}>Cancel</button>
              <button
                className="btn-primary"
                onClick={handleCapture}
                disabled={capturing || !captureName.trim()}
              >
                {capturing ? 'Capturing...' : 'Capture & Generate Fake'}
              </button>
            </>
          )
        }
      >
        {capturedFake ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-zinc-400">
              Token captured. Send this fake token to the owner of <strong>{captureToken?.service}</strong> to replace their real key:
            </p>
            <div className="relative">
              <code className="block w-full rounded-lg bg-slate-100 dark:bg-zinc-800 p-3 text-xs font-mono text-slate-800 dark:text-zinc-200 break-all select-all">
                {capturedFake}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(capturedFake);
                  notify('success', 'Copied to clipboard.');
                }}
                className="absolute top-2 right-2 btn-ghost p-1.5 rounded-md"
                title="Copy"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-zinc-400">
              Service <strong>{captureToken?.service}</strong> is using token <code className="text-xs font-mono bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 px-1.5 py-0.5 rounded">{captureToken?.preview}</code> directly.
              Overbearer will retrieve the full token from the encrypted logs and generate a safe replacement automatically.
            </p>
            <div>
              <label className="label">Name</label>
              <input className="input" value={captureName} onChange={(e) => setCaptureName(e.target.value)} placeholder="e.g. Production Anthropic Key" />
            </div>
            <div>
              <label className="label">Provider <span className="text-slate-400 dark:text-zinc-600 font-normal">(optional)</span></label>
              <input className="input" value={captureProvider} onChange={(e) => setCaptureProvider(e.target.value)} placeholder="e.g. anthropic, openai" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
