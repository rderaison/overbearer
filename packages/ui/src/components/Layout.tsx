import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Key,
  GitPullRequestArrow,
  ScrollText,
  Server,
  Users,
  Settings,
  LogOut,
  Menu,
  X,
  Shield,
} from 'lucide-react';
import clsx from 'clsx';
import { ThemeToggle } from './ThemeToggle';
import { auth, type Role, type User } from '../lib/api';
import { useNotification } from './Notification';

// ---------------------------------------------------------------------------
// Navigation definition
// ---------------------------------------------------------------------------

interface NavItem {
  label: string;
  to: string;
  icon: React.ElementType;
  /** Roles that can see this item. Undefined = all roles. */
  roles?: Role[];
}

const navItems: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard },
  {
    label: 'Tokens',
    to: '/tokens',
    icon: Key,
    roles: ['admin', 'manager'],
  },
  {
    label: 'Token Requests',
    to: '/token-requests',
    icon: GitPullRequestArrow,
    roles: ['admin', 'manager', 'requester'],
  },
  {
    label: 'Logs',
    to: '/logs',
    icon: ScrollText,
    roles: ['admin', 'viewer'],
  },
  {
    label: 'Services',
    to: '/services',
    icon: Server,
    roles: ['admin', 'viewer'],
  },
  { label: 'Users', to: '/users', icon: Users, roles: ['admin'] },
  { label: 'Settings', to: '/settings', icon: Settings, roles: ['admin'] },
];

function visibleItems(role: Role) {
  return navItems.filter((i) => !i.roles || i.roles.includes(role));
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface LayoutProps {
  user: User;
  onLogout: () => void;
}

export function Layout({ user, onLogout }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const { notify } = useNotification();

  const items = visibleItems(user.role);

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch {
      // best-effort
    }
    onLogout();
    navigate('/login');
    notify('info', 'Signed out successfully.');
  };

  return (
    <div className="flex h-screen overflow-hidden bg-slate-100 dark:bg-zinc-950">
      {/* ---- Mobile overlay ---- */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ---- Sidebar ---- */}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-white dark:bg-zinc-900 border-r border-slate-200 dark:border-zinc-800 transition-transform duration-200 lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Brand */}
        <div className="flex h-16 items-center gap-3 px-5 border-b border-slate-200 dark:border-zinc-800">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-brand-600">
            <Shield className="h-4 w-4 text-white" />
          </div>
          <span className="text-lg font-bold text-slate-900 dark:text-zinc-100 tracking-tight">
            Overbearer
          </span>
          {/* Close button (mobile) */}
          <button
            className="ml-auto lg:hidden btn-ghost p-1 rounded-lg"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400'
                    : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 hover:text-slate-900 dark:hover:text-zinc-200',
                )
              }
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-slate-200 dark:border-zinc-800 p-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-500/20 text-brand-700 dark:text-brand-400 text-sm font-semibold">
              {user.displayName?.charAt(0)?.toUpperCase() ??
                user.username.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-900 dark:text-zinc-100 truncate">
                {user.displayName || user.username}
              </p>
              <p className="text-xs text-slate-500 dark:text-zinc-500 capitalize">
                {user.role}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="btn-ghost p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ---- Main content ---- */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-16 items-center gap-4 border-b border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 lg:px-6">
          <button
            className="lg:hidden btn-ghost p-2 rounded-lg"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* Spacer */}
          <div className="flex-1" />

          <ThemeToggle />
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
