import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Shield, UserCheck } from 'lucide-react';
import { useNotification } from '../components/Notification';

interface InviteInfo {
  username: string;
  displayName: string;
  role: string;
}

export function InvitePage({ onLogin }: { onLogin: (user: any) => void }) {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { notify } = useNotification();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/invite/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || 'Invalid invite');
          return;
        }
        setInfo(await res.json());
      })
      .catch(() => setError('Failed to validate invite'));
  }, [token]);

  const handleAccept = async () => {
    setAccepting(true);
    try {
      const res = await fetch(`/api/invite/${token}/accept`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to accept invite');
      }
      // Fetch user info
      const meRes = await fetch('/api/auth/me', { credentials: 'include' });
      const user = await meRes.json();
      notify('success', `Welcome, ${info?.displayName || info?.username}! You can register a passkey in Settings.`);
      onLogin(user);
      navigate('/');
    } catch (err: any) {
      notify('error', err.message);
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-brand-50 dark:from-zinc-950 dark:via-zinc-950 dark:to-brand-950/20 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 shadow-lg shadow-brand-500/30">
            <Shield className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100 tracking-tight">
            Overbearer
          </h1>
        </div>

        <div className="card p-6">
          {error ? (
            <div className="text-center">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              <button className="btn-primary mt-4" onClick={() => navigate('/login')}>
                Go to Login
              </button>
            </div>
          ) : !info ? (
            <div className="flex justify-center py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-600 border-t-transparent" />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-1">
                <UserCheck className="h-5 w-5 text-brand-600 dark:text-brand-400" />
                <h2 className="text-lg font-semibold text-slate-900 dark:text-zinc-100">
                  You've been invited
                </h2>
              </div>
              <p className="text-sm text-slate-500 dark:text-zinc-500 mb-6">
                An administrator has invited you to join Overbearer.
              </p>

              <dl className="space-y-3 mb-6 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500 dark:text-zinc-500">Username</dt>
                  <dd className="font-medium text-slate-900 dark:text-zinc-100">{info.username}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500 dark:text-zinc-500">Display Name</dt>
                  <dd className="font-medium text-slate-900 dark:text-zinc-100">{info.displayName}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500 dark:text-zinc-500">Role</dt>
                  <dd className="font-medium text-slate-900 dark:text-zinc-100 capitalize">{info.role}</dd>
                </div>
              </dl>

              <button
                className="btn-primary w-full py-2.5"
                onClick={handleAccept}
                disabled={accepting}
              >
                {accepting ? 'Joining...' : 'Accept Invite & Join'}
              </button>

              <p className="mt-4 text-xs text-slate-400 dark:text-zinc-600 text-center">
                After joining, go to Settings to register a passkey for future logins.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
