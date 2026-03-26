import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Copy, RotateCw, Ban, Search, X, UserPlus, UsersRound } from 'lucide-react';
import {
  tokens,
  users as usersApi,
  groups as groupsApi,
  type Token,
  type TokenCreateResult,
  type User,
  type Group,
} from '../lib/api';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useNotification } from '../components/Notification';

// ---------------------------------------------------------------------------
// Create Token Modal
// ---------------------------------------------------------------------------

function CreateTokenModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: TokenCreateResult) => void;
}) {
  const { notify } = useNotification();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [realToken, setRealToken] = useState('');
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setName('');
    setProvider('');
    setRealToken('');
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const result = await tokens.create({ name, provider, realToken });
      onCreated(result);
      notify('success', `Token "${name}" created successfully.`);
      reset();
      onClose();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to create token.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Create Token"
      actions={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={loading || !name.trim() || !provider.trim() || !realToken.trim()}
          >
            {loading ? 'Creating...' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label">Name</label>
          <input
            className="input"
            placeholder="e.g. Production OpenAI key"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Provider</label>
          <input
            className="input"
            placeholder="e.g. openai, anthropic, github"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Real Token</label>
          <input
            className="input font-mono text-xs"
            type="text"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            placeholder="sk-..."
            value={realToken}
            onChange={(e) => setRealToken(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-zinc-500">
            This will be encrypted and stored securely.
          </p>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Fake Token Display Modal
// ---------------------------------------------------------------------------

function FakeTokenModal({
  open,
  onClose,
  fakeToken,
}: {
  open: boolean;
  onClose: () => void;
  fakeToken: string;
}) {
  const { notify } = useNotification();

  const copy = () => {
    navigator.clipboard.writeText(fakeToken).then(
      () => notify('success', 'Copied to clipboard.'),
      () => notify('error', 'Failed to copy.'),
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Token Created" size="md">
      <div className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-zinc-400">
          Use this fake token in your services. Overbearer will swap it with the
          real token automatically.
        </p>
        <div className="relative">
          <code className="block w-full rounded-lg bg-slate-100 dark:bg-zinc-800 p-3 text-xs font-mono text-slate-800 dark:text-zinc-200 break-all select-all">
            {fakeToken}
          </code>
          <button
            onClick={copy}
            className="absolute top-2 right-2 btn-ghost p-1.5 rounded-md"
            title="Copy to clipboard"
          >
            <Copy className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Make sure to copy this token now. You can view it later from the token
          list, but it is safer to copy it now.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Rotate Modal
// ---------------------------------------------------------------------------

function RotateModal({
  open,
  onClose,
  token,
  onRotated,
}: {
  open: boolean;
  onClose: () => void;
  token: Token | null;
  onRotated: () => void;
}) {
  const { notify } = useNotification();
  const [realToken, setRealToken] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRotate = async () => {
    if (!token) return;
    setLoading(true);
    try {
      await tokens.rotate(token.id, { realToken });
      notify('success', `Token "${token.name}" rotated.`);
      setRealToken('');
      onRotated();
      onClose();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to rotate token.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        setRealToken('');
        onClose();
      }}
      title={`Rotate "${token?.name ?? ''}"`}
      size="sm"
      actions={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleRotate}
            disabled={loading || !realToken.trim()}
          >
            {loading ? 'Rotating...' : 'Rotate'}
          </button>
        </>
      }
    >
      <div>
        <label className="label">New Real Token</label>
        <input
          className="input font-mono text-xs"
          type="text"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          placeholder="sk-..."
          value={realToken}
          onChange={(e) => setRealToken(e.target.value)}
        />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Tokens page
// ---------------------------------------------------------------------------

export function Tokens() {
  const navigate = useNavigate();
  const { notify } = useNotification();
  const [data, setData] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // modals
  const [showCreate, setShowCreate] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<Token | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Token | null>(null);
  const [revoking, setRevoking] = useState(false);

  // detail / access management modal
  const [detailToken, setDetailToken] = useState<Token | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addGroupOpen, setAddGroupOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await tokens.list();
      setData(res.tokens);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await tokens.revoke(revokeTarget.id);
      notify('success', `Token "${revokeTarget.name}" revoked.`);
      setRevokeTarget(null);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to revoke token.');
    } finally {
      setRevoking(false);
    }
  };

  // --- Detail / Access Management ---
  const openDetail = async (token: Token) => {
    setDetailToken(token);
    setAddUserOpen(false);
    setAddGroupOpen(false);
    try {
      const [u, g] = await Promise.all([usersApi.list(), groupsApi.list()]);
      setAllUsers(u.users);
      setAllGroups(g.groups);
    } catch {
      // dropdown data unavailable — non-critical
    }
  };

  const closeDetail = () => {
    setDetailToken(null);
    setAddUserOpen(false);
    setAddGroupOpen(false);
  };

  const refreshDetail = async () => {
    const res = await tokens.list();
    setData(res.tokens);
    if (detailToken) {
      const updated = res.tokens.find((t) => t.id === detailToken.id);
      setDetailToken(updated ?? null);
    }
  };

  const handleGrantUser = async (userId: string) => {
    if (!detailToken) return;
    try {
      await tokens.grantAccess(detailToken.id, { userId });
      notify('success', 'User access granted.');
      setAddUserOpen(false);
      refreshDetail();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to grant access.');
    }
  };

  const handleGrantGroup = async (groupId: string) => {
    if (!detailToken) return;
    try {
      await tokens.grantAccess(detailToken.id, { groupId });
      notify('success', 'Group access granted.');
      setAddGroupOpen(false);
      refreshDetail();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to grant access.');
    }
  };

  const handleRevokeUser = async (userId: string) => {
    if (!detailToken) return;
    try {
      await tokens.revokeUserAccess(detailToken.id, userId);
      notify('success', 'User access revoked.');
      refreshDetail();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to revoke access.');
    }
  };

  const handleRevokeGroup = async (groupId: string) => {
    if (!detailToken) return;
    try {
      await tokens.revokeGroupAccess(detailToken.id, groupId);
      notify('success', 'Group access revoked.');
      refreshDetail();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to revoke access.');
    }
  };

  const accessUsers = detailToken?.accessibleBy?.users ?? [];
  const accessGroups = detailToken?.accessibleBy?.groups ?? [];
  const availableUsers = allUsers.filter((u) => !accessUsers.some((au) => au.id === u.id));
  const availableGroups = allGroups.filter((g) => !accessGroups.some((ag) => ag.id === g.id));

  const filtered = data.filter(
    (t: any) =>
      (t.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (t.provider ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  const columns: Column<any>[] = [
    { key: 'name', header: 'Name', sortable: true },
    { key: 'provider', header: 'Provider', sortable: true },
    {
      key: 'fakeToken',
      header: 'Fake Token',
      render: (t: any) => {
        if (!t.fakeToken) return <span className="text-slate-400 dark:text-zinc-600">—</span>;
        return (
          <div className="flex items-center gap-1.5">
            <code className="text-xs font-mono text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-500/10 px-2 py-0.5 rounded max-w-[220px] truncate block select-all">
              {t.fakeToken}
            </code>
            <button
              className="btn-ghost p-1 rounded"
              title="Copy"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                navigator.clipboard.writeText(t.fakeToken);
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (t: any) => <StatusBadge status={t.status} />,
    },
    {
      key: 'createdBy',
      header: 'Created By',
      sortable: true,
    },
    {
      key: 'requestCount',
      header: 'Usage',
      sortable: true,
      render: (t: any) => {
        const count = t.requestCount ?? 0;
        if (count === 0) return <span className="text-slate-400 dark:text-zinc-600 tabular-nums">0</span>;
        const hashPrefix = t.fakeToken ? undefined : undefined; // we use token_id from the API
        return (
          <button
            className="text-brand-600 dark:text-brand-400 hover:underline font-medium tabular-nums"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              navigate(`/logs?token_type=fake`);
            }}
            title="View usage logs"
          >
            {count} request{count !== 1 ? 's' : ''}
          </button>
        );
      },
    },
    {
      key: 'accessibleBy',
      header: 'Access',
      render: (t: any) => {
        const users = (t.accessibleBy?.users ?? []) as { id: string; username: string }[];
        const groups = (t.accessibleBy?.groups ?? []) as { id: string; name: string }[];
        if (users.length === 0 && groups.length === 0) {
          return <span className="text-slate-400 dark:text-zinc-600 text-xs">No access grants</span>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {users.map((u) => (
              <span
                key={u.id}
                className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400"
              >
                @{u.username}
              </span>
            ))}
            {groups.map((g) => (
              <span
                key={g.id}
                className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-400"
              >
                {g.name}
              </span>
            ))}
          </div>
        );
      },
    },
    {
      key: 'services',
      header: 'Used By',
      render: (t: any) => {
        const svcs = (t.services ?? []) as string[];
        if (svcs.length === 0) return <span className="text-slate-400 dark:text-zinc-600">—</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {svcs.map((s: string, i: number) => (
              <code key={i} className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-100 dark:bg-zinc-800 rounded">
                {s}
              </code>
            ))}
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      render: (t: any) =>
        t.status === 'active' ? (
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost p-1.5 rounded-md"
              title="Rotate"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                setRotateTarget(t);
              }}
            >
              <RotateCw className="h-4 w-4" />
            </button>
            <button
              className="btn-ghost p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
              title="Revoke"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                setRevokeTarget(t);
              }}
            >
              <Ban className="h-4 w-4" />
            </button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">
            Tokens
          </h1>
          <p className="text-sm text-slate-500 dark:text-zinc-500 mt-1">
            Manage API token mappings.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          Create Token
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-zinc-500" />
        <input
          className="input pl-9"
          placeholder="Filter by name or provider..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <DataTable
        columns={columns}
        data={filtered}
        rowKey={(t) => t.id}
        loading={loading}
        emptyMessage="No tokens found."
        onRowClick={(t) => openDetail(t)}
      />

      {/* Modals */}
      <CreateTokenModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(result) => {
          setCreatedToken(result.fakeToken);
          load();
        }}
      />

      <FakeTokenModal
        open={createdToken !== null}
        onClose={() => setCreatedToken(null)}
        fakeToken={createdToken ?? ''}
      />

      <RotateModal
        open={rotateTarget !== null}
        onClose={() => setRotateTarget(null)}
        token={rotateTarget}
        onRotated={load}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title="Revoke Token"
        message={`Are you sure you want to revoke "${revokeTarget?.name}"? Services using this token will stop working.`}
        confirmLabel="Revoke"
        loading={revoking}
      />

      {/* Token Detail / Access Management Modal */}
      <Modal
        open={detailToken !== null}
        onClose={closeDetail}
        title={detailToken?.name ?? ''}
        size="lg"
      >
        {detailToken && (
          <div className="space-y-6">
            {/* Token info */}
            <div className="flex flex-wrap items-center gap-3">
              {detailToken.provider && (
                <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-zinc-400">
                  {detailToken.provider}
                </span>
              )}
              <StatusBadge status={detailToken.status} />
              <span className="text-xs text-slate-400 dark:text-zinc-600">
                Created by {detailToken.createdBy} on{' '}
                {new Date(detailToken.createdAt).toLocaleDateString()}
              </span>
            </div>

            {detailToken.fakeToken && (
              <div className="relative">
                <code className="block w-full rounded-lg bg-slate-100 dark:bg-zinc-800 p-3 text-xs font-mono text-slate-800 dark:text-zinc-200 break-all select-all">
                  {detailToken.fakeToken}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(detailToken.fakeToken);
                    notify('success', 'Copied to clipboard.');
                  }}
                  className="absolute top-2 right-2 btn-ghost p-1.5 rounded-md"
                  title="Copy fake token"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* Access management */}
            <div className="grid gap-6 md:grid-cols-2">
              {/* Users with access */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                    <UserPlus className="h-4 w-4" />
                    User Access
                  </h4>
                  <div className="relative">
                    <button
                      className="btn-ghost text-xs p-1.5 rounded-md"
                      onClick={() => { setAddUserOpen(!addUserOpen); setAddGroupOpen(false); }}
                      title="Grant user access"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    {addUserOpen && (
                      <div className="absolute right-0 top-full mt-1 z-10 w-56 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-lg max-h-48 overflow-y-auto">
                        {availableUsers.length === 0 ? (
                          <p className="text-xs text-slate-500 dark:text-zinc-500 p-3">
                            No users available to add.
                          </p>
                        ) : (
                          availableUsers.map((u) => (
                            <button
                              key={u.id}
                              className="w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
                              onClick={() => handleGrantUser(u.id)}
                            >
                              {u.username}
                              {u.displayName && (
                                <span className="text-slate-400 dark:text-zinc-600 ml-1">
                                  ({u.displayName})
                                </span>
                              )}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {accessUsers.length === 0 ? (
                  <p className="text-xs text-slate-400 dark:text-zinc-600">No user access grants.</p>
                ) : (
                  <ul className="space-y-1">
                    {accessUsers.map((u) => (
                      <li
                        key={u.id}
                        className="flex items-center justify-between rounded-lg px-3 py-2 bg-slate-50 dark:bg-zinc-800/50"
                      >
                        <span className="text-sm font-medium text-slate-900 dark:text-zinc-100 truncate">
                          @{u.username}
                        </span>
                        <button
                          className="btn-ghost p-1 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 flex-shrink-0"
                          title="Revoke access"
                          onClick={() => handleRevokeUser(u.id)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Groups with access */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                    <UsersRound className="h-4 w-4" />
                    Group Access
                  </h4>
                  <div className="relative">
                    <button
                      className="btn-ghost text-xs p-1.5 rounded-md"
                      onClick={() => { setAddGroupOpen(!addGroupOpen); setAddUserOpen(false); }}
                      title="Grant group access"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    {addGroupOpen && (
                      <div className="absolute right-0 top-full mt-1 z-10 w-56 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-lg max-h-48 overflow-y-auto">
                        {availableGroups.length === 0 ? (
                          <p className="text-xs text-slate-500 dark:text-zinc-500 p-3">
                            No groups available to add.
                          </p>
                        ) : (
                          availableGroups.map((g) => (
                            <button
                              key={g.id}
                              className="w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
                              onClick={() => handleGrantGroup(g.id)}
                            >
                              {g.name}
                              {g.description && (
                                <span className="text-slate-400 dark:text-zinc-600 ml-1">
                                  ({g.description})
                                </span>
                              )}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {accessGroups.length === 0 ? (
                  <p className="text-xs text-slate-400 dark:text-zinc-600">No group access grants.</p>
                ) : (
                  <ul className="space-y-1">
                    {accessGroups.map((g) => (
                      <li
                        key={g.id}
                        className="flex items-center justify-between rounded-lg px-3 py-2 bg-slate-50 dark:bg-zinc-800/50"
                      >
                        <span className="text-sm font-medium text-slate-900 dark:text-zinc-100 truncate">
                          {g.name}
                        </span>
                        <button
                          className="btn-ghost p-1 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 flex-shrink-0"
                          title="Revoke access"
                          onClick={() => handleRevokeGroup(g.id)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
