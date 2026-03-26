import { useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from 'react-router-dom';

import { auth, type User } from './lib/api';
import { Layout } from './components/Layout';
import { NotificationProvider } from './components/Notification';

import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Tokens } from './pages/Tokens';
import { TokenRequests } from './pages/TokenRequests';
import { Logs } from './pages/Logs';
import { Services } from './pages/Services';
import { NewActivity } from './pages/NewActivity';
import { UsersPage } from './pages/Users';
import { GroupsPage } from './pages/Groups';
import { SettingsPage } from './pages/Settings';
import { InvitePage } from './pages/Invite';

// ---------------------------------------------------------------------------
// Auth context passed via props (no React context needed -- kept simple)
// ---------------------------------------------------------------------------

function ProtectedRoute({
  user,
  children,
}: {
  user: User | null;
  children: ReactNode;
}) {
  const location = useLocation();
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Theme initialisation
// ---------------------------------------------------------------------------

function initTheme() {
  const stored = localStorage.getItem('overbearer-theme');
  if (stored === 'dark') {
    document.documentElement.classList.add('dark');
  } else if (stored === 'light') {
    document.documentElement.classList.remove('dark');
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.classList.add('dark');
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    initTheme();
    auth
      .me()
      .then((u) => setUser(u as User))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const handleLogin = useCallback((u: User) => setUser(u), []);
  const handleLogout = useCallback(() => setUser(null), []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-white dark:bg-zinc-950">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <NotificationProvider>
        <Routes>
          {/* Public */}
          <Route
            path="/login"
            element={
              user ? (
                <Navigate to="/" replace />
              ) : (
                <Login onLogin={handleLogin} />
              )
            }
          />

          {/* Invite (public) */}
          <Route
            path="/invite/:token"
            element={<InvitePage onLogin={handleLogin} />}
          />

          {/* Protected */}
          <Route
            element={
              <ProtectedRoute user={user}>
                <Layout user={user!} onLogout={handleLogout} />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="tokens" element={<Tokens />} />
            <Route path="token-requests" element={<TokenRequests />} />
            <Route path="logs" element={<Logs />} />
            <Route path="services" element={<Services />} />
            <Route path="new-activity" element={<NewActivity />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="groups" element={<GroupsPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </NotificationProvider>
    </BrowserRouter>
  );
}
