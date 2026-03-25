import { useState, useEffect } from 'react';
import { Shield, Fingerprint, UserPlus, Rocket } from 'lucide-react';
import { auth, type User } from '../lib/api';
import { loginWithPasskey, registerPasskey } from '../lib/auth';
import { useNotification } from '../components/Notification';

interface LoginProps {
  onLogin: (user: User) => void;
}

export function Login({ onLogin }: LoginProps) {
  const { notify } = useNotification();
  const [mode, setMode] = useState<'loading' | 'setup' | 'login' | 'register'>('loading');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    auth.setupStatus()
      .then(({ needsSetup }) => setMode(needsSetup ? 'setup' : 'login'))
      .catch(() => setMode('login'));
  }, []);

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    setLoading(true);
    try {
      const { user } = await auth.setup(username.trim(), displayName.trim() || undefined);
      notify('success', `Welcome, ${user.displayName || user.username}! You are the first admin.`);
      onLogin(user);
    } catch (err: any) {
      notify('error', err?.message ?? 'Setup failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    setLoading(true);
    try {
      const user = await loginWithPasskey();
      notify('success', `Welcome back, ${user.displayName || user.username}!`);
      onLogin(user);
    } catch (err: any) {
      notify('error', err?.message ?? 'Authentication failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    setLoading(true);
    try {
      const user = await registerPasskey(username.trim());
      notify('success', `Account created! Welcome, ${user.displayName || user.username}.`);
      onLogin(user);
    } catch (err: any) {
      notify('error', err?.message ?? 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (mode === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-brand-50 dark:from-zinc-950 dark:via-zinc-950 dark:to-brand-950/20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-brand-50 dark:from-zinc-950 dark:via-zinc-950 dark:to-brand-950/20 px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 shadow-lg shadow-brand-500/30">
            <Shield className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100 tracking-tight">
            Overbearer
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-zinc-500">
            API Token Management Proxy
          </p>
        </div>

        {/* Card */}
        <div className="card p-6">
          {mode === 'setup' ? (
            <>
              <div className="flex items-center gap-2 mb-1">
                <Rocket className="h-5 w-5 text-brand-600 dark:text-brand-400" />
                <h2 className="text-lg font-semibold text-slate-900 dark:text-zinc-100">
                  Initial Setup
                </h2>
              </div>
              <p className="text-sm text-slate-500 dark:text-zinc-500 mb-6">
                Create the first admin account to get started. You can add a passkey later from Settings.
              </p>

              <form onSubmit={handleSetup} className="space-y-4">
                <div>
                  <label htmlFor="setup-username" className="label">
                    Username
                  </label>
                  <input
                    id="setup-username"
                    type="text"
                    className="input"
                    placeholder="e.g. admin"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                    required
                    minLength={2}
                    maxLength={64}
                  />
                </div>
                <div>
                  <label htmlFor="setup-display" className="label">
                    Display Name <span className="text-slate-400 dark:text-zinc-600 font-normal">(optional)</span>
                  </label>
                  <input
                    id="setup-display"
                    type="text"
                    className="input"
                    placeholder="e.g. Alice Admin"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    maxLength={255}
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || !username.trim()}
                  className="btn-primary w-full py-2.5"
                >
                  <UserPlus className="h-5 w-5" />
                  {loading ? 'Creating account...' : 'Create Admin Account'}
                </button>
              </form>
            </>
          ) : mode === 'login' ? (
            <>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-zinc-100 mb-1">
                Welcome back
              </h2>
              <p className="text-sm text-slate-500 dark:text-zinc-500 mb-6">
                Sign in with your passkey to continue.
              </p>

              <button
                onClick={handleLogin}
                disabled={loading}
                className="btn-primary w-full py-2.5"
              >
                <Fingerprint className="h-5 w-5" />
                {loading ? 'Authenticating...' : 'Sign in with Passkey'}
              </button>

              <div className="mt-6 text-center">
                <button
                  onClick={() => setMode('register')}
                  className="text-sm text-brand-600 dark:text-brand-400 hover:underline"
                >
                  Register a new account
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-zinc-100 mb-1">
                Create account
              </h2>
              <p className="text-sm text-slate-500 dark:text-zinc-500 mb-6">
                Choose a username and register a passkey.
              </p>

              <form onSubmit={handleRegister} className="space-y-4">
                <div>
                  <label htmlFor="username" className="label">
                    Username
                  </label>
                  <input
                    id="username"
                    type="text"
                    className="input"
                    placeholder="e.g. alice"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                    required
                    minLength={2}
                    maxLength={64}
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || !username.trim()}
                  className="btn-primary w-full py-2.5"
                >
                  <UserPlus className="h-5 w-5" />
                  {loading ? 'Registering...' : 'Register with Passkey'}
                </button>
              </form>

              <div className="mt-6 text-center">
                <button
                  onClick={() => setMode('login')}
                  className="text-sm text-brand-600 dark:text-brand-400 hover:underline"
                >
                  Already have an account? Sign in
                </button>
              </div>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-400 dark:text-zinc-600">
          Secured with WebAuthn / FIDO2 passkeys
        </p>
      </div>
    </div>
  );
}
