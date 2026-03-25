import { useEffect, useState, useCallback } from 'react';
import { Trash2, UserPlus, Copy, Link } from 'lucide-react';
import { users as usersApi, type User, type Role } from '../lib/api';
import { DataTable, type Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useNotification } from '../components/Notification';

const roleOptions: Role[] = ['admin', 'manager', 'viewer', 'requester'];

export function UsersPage() {
  const { notify } = useNotification();
  const [data, setData] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);

  // New user modal
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<Role>('viewer');
  const [creating, setCreating] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await usersApi.list();
      setData(res.users);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRoleChange = async (user: User, nr: Role) => {
    try {
      await usersApi.updateRole(user.id, nr);
      notify('success', `Updated ${user.username} to ${nr}.`);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to update role.');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await usersApi.delete(deleteTarget.id);
      notify('success', `User "${deleteTarget.username}" deleted.`);
      setDeleteTarget(null);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to delete user.');
    } finally {
      setDeleting(false);
    }
  };

  const handleCreate = async () => {
    if (!newUsername.trim()) return;
    setCreating(true);
    try {
      const res = await usersApi.create(newUsername.trim(), newDisplayName.trim() || undefined, newRole);
      setInviteUrl((res as any).inviteUrl ?? null);
      notify('success', `User "${newUsername}" created.`);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to create user.');
    } finally {
      setCreating(false);
    }
  };

  const closeCreateModal = () => {
    setShowCreate(false);
    setNewUsername('');
    setNewDisplayName('');
    setNewRole('viewer');
    setInviteUrl(null);
  };

  const columns: Column<User>[] = [
    {
      key: 'username',
      header: 'Username',
      sortable: true,
      render: (u) => (
        <span className="font-medium text-slate-900 dark:text-zinc-100">
          {u.username}
        </span>
      ),
    },
    {
      key: 'displayName',
      header: 'Display Name',
      sortable: true,
      render: (u) => u.displayName || <span className="text-slate-400 dark:text-zinc-600">--</span>,
    },
    {
      key: 'role',
      header: 'Role',
      sortable: true,
      render: (u) => (
        <select
          className="input py-1 px-2 w-auto text-xs"
          value={u.role}
          onChange={(e) => handleRoleChange(u, e.target.value as Role)}
          onClick={(e) => e.stopPropagation()}
        >
          {roleOptions.map((r) => (
            <option key={r} value={r}>
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortable: true,
      render: (u) => (
        <span className="text-xs tabular-nums">
          {new Date(u.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (u) => (
        <button
          className="btn-ghost p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
          title="Delete user"
          onClick={(e) => {
            e.stopPropagation();
            setDeleteTarget(u);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">
            Users
          </h1>
          <p className="text-sm text-slate-500 dark:text-zinc-500 mt-1">
            Manage user accounts and roles.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <UserPlus className="h-4 w-4" />
          New User
        </button>
      </div>

      <DataTable
        columns={columns}
        data={data}
        rowKey={(u) => u.id}
        loading={loading}
        emptyMessage="No users found."
      />

      {/* Create User Modal */}
      <Modal
        open={showCreate}
        onClose={closeCreateModal}
        title={inviteUrl ? 'Invite Link' : 'New User'}
        size="md"
        actions={
          inviteUrl ? (
            <button className="btn-primary" onClick={closeCreateModal}>Done</button>
          ) : (
            <>
              <button className="btn-secondary" onClick={closeCreateModal} disabled={creating}>Cancel</button>
              <button className="btn-primary" onClick={handleCreate} disabled={creating || !newUsername.trim()}>
                {creating ? 'Creating...' : 'Create & Generate Invite'}
              </button>
            </>
          )
        }
      >
        {inviteUrl ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-zinc-400">
              Send this link to <strong>{newUsername}</strong>. It's valid for 7 days and can only be used once.
            </p>
            <div className="relative">
              <div className="flex items-center gap-2 rounded-lg bg-slate-100 dark:bg-zinc-800 p-3">
                <Link className="h-4 w-4 text-slate-400 flex-shrink-0" />
                <code className="text-xs font-mono text-slate-800 dark:text-zinc-200 break-all select-all flex-1">
                  {inviteUrl}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(inviteUrl);
                    notify('success', 'Invite link copied.');
                  }}
                  className="btn-ghost p-1.5 rounded-md flex-shrink-0"
                  title="Copy"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="label">Username</label>
              <input
                className="input"
                placeholder="e.g. alice"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="label">Display Name <span className="text-slate-400 dark:text-zinc-600 font-normal">(optional)</span></label>
              <input
                className="input"
                placeholder="e.g. Alice Smith"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Role</label>
              <select className="input" value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
                {roleOptions.map((r) => (
                  <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete User"
        message={`Are you sure you want to delete "${deleteTarget?.username}"? This action cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}
