import { useEffect, useState, useCallback } from 'react';
import {
  UsersRound,
  Key,
  Plus,
  X,
  Trash2,
  UserPlus,
  KeyRound,
} from 'lucide-react';
import {
  groups as groupsApi,
  users as usersApi,
  tokens as tokensApi,
  type Group,
  type GroupDetail,
  type User,
  type Token,
} from '../lib/api';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useNotification } from '../components/Notification';

export function GroupsPage() {
  const { notify } = useNotification();
  const [data, setData] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  // Create group modal
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);

  // Detail modal
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [editDescription, setEditDescription] = useState('');

  // Members / tokens management
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [allTokens, setAllTokens] = useState<Token[]>([]);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [grantTokenOpen, setGrantTokenOpen] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<Group | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await groupsApi.list();
      setData(res.groups);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (group: Group) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const [res, usersRes, tokensRes] = await Promise.all([
        groupsApi.get(group.id),
        usersApi.list(),
        tokensApi.list(),
      ]);
      setDetail(res.group);
      setAllUsers(usersRes.users);
      setAllTokens(tokensRes.tokens);
      setEditName(res.group.name);
      setEditDescription(res.group.description ?? '');
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to load group details.');
    } finally {
      setDetailLoading(false);
    }
  };

  const reloadDetail = async (groupId: string) => {
    try {
      const res = await groupsApi.get(groupId);
      setDetail(res.group);
      setEditName(res.group.name);
      setEditDescription(res.group.description ?? '');
    } catch {
      // ignore
    }
  };

  const closeDetail = () => {
    setDetail(null);
    setDetailLoading(false);
    setEditingName(false);
    setEditingDescription(false);
    setAddMemberOpen(false);
    setGrantTokenOpen(false);
  };

  // --- Create group ---
  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await groupsApi.create({
        name: newName.trim(),
        description: newDescription.trim() || undefined,
      });
      notify('success', `Group "${newName}" created.`);
      closeCreateModal();
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to create group.');
    } finally {
      setCreating(false);
    }
  };

  const closeCreateModal = () => {
    setShowCreate(false);
    setNewName('');
    setNewDescription('');
  };

  // --- Edit name ---
  const handleSaveName = async () => {
    if (!detail || !editName.trim()) return;
    try {
      await groupsApi.update(detail.id, { name: editName.trim() });
      notify('success', 'Group name updated.');
      setEditingName(false);
      reloadDetail(detail.id);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to update name.');
    }
  };

  // --- Edit description ---
  const handleSaveDescription = async () => {
    if (!detail) return;
    try {
      await groupsApi.update(detail.id, { description: editDescription.trim() || undefined });
      notify('success', 'Description updated.');
      setEditingDescription(false);
      reloadDetail(detail.id);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to update description.');
    }
  };

  // --- Members ---
  const handleAddMember = async (userId: string) => {
    if (!detail) return;
    try {
      await groupsApi.addMember(detail.id, userId);
      notify('success', 'Member added.');
      setAddMemberOpen(false);
      reloadDetail(detail.id);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to add member.');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!detail) return;
    try {
      await groupsApi.removeMember(detail.id, userId);
      notify('success', 'Member removed.');
      reloadDetail(detail.id);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to remove member.');
    }
  };

  // --- Tokens ---
  const handleGrantToken = async (tokenId: string) => {
    if (!detail) return;
    try {
      await groupsApi.grantToken(detail.id, tokenId);
      notify('success', 'Token access granted.');
      setGrantTokenOpen(false);
      reloadDetail(detail.id);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to grant token.');
    }
  };

  const handleRevokeToken = async (tokenId: string) => {
    if (!detail) return;
    try {
      await groupsApi.revokeToken(detail.id, tokenId);
      notify('success', 'Token access revoked.');
      reloadDetail(detail.id);
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to revoke token.');
    }
  };

  // --- Delete group ---
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await groupsApi.delete(deleteTarget.id);
      notify('success', `Group "${deleteTarget.name}" deleted.`);
      setDeleteTarget(null);
      closeDetail();
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to delete group.');
    } finally {
      setDeleting(false);
    }
  };

  // Derived data for add-member dropdown (users not already in group)
  const availableUsers = detail
    ? allUsers.filter((u) => !detail.members.some((m) => m.id === u.id))
    : [];

  // Derived data for grant-token dropdown (tokens not already granted)
  const availableTokens = detail
    ? allTokens.filter((t) => !detail.tokens.some((gt) => gt.id === t.id))
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">
            Groups
          </h1>
          <p className="text-sm text-slate-500 dark:text-zinc-500 mt-1">
            Manage groups, members, and token access.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          Create Group
        </button>
      </div>

      {/* Group Cards */}
      {loading ? (
        <div className="text-sm text-slate-500 dark:text-zinc-500">Loading...</div>
      ) : data.length === 0 ? (
        <div className="text-sm text-slate-500 dark:text-zinc-500">No groups found.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((group) => (
            <button
              key={group.id}
              onClick={() => openDetail(group)}
              className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl p-5 text-left hover:border-slate-300 dark:hover:border-zinc-700 transition-colors"
            >
              <h3 className="font-semibold text-slate-900 dark:text-zinc-100 truncate">
                {group.name}
              </h3>
              {group.description && (
                <p className="text-sm text-slate-500 dark:text-zinc-500 mt-1 line-clamp-2">
                  {group.description}
                </p>
              )}
              <div className="flex items-center gap-3 mt-3">
                <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-zinc-500">
                  <UsersRound className="h-3.5 w-3.5" />
                  {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
                </span>
                <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-zinc-500">
                  <Key className="h-3.5 w-3.5" />
                  {group.tokenCount} {group.tokenCount === 1 ? 'token' : 'tokens'}
                </span>
              </div>
              <p className="text-xs text-slate-400 dark:text-zinc-600 mt-2">
                Created {new Date(group.createdAt).toLocaleDateString()}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* Create Group Modal */}
      <Modal
        open={showCreate}
        onClose={closeCreateModal}
        title="Create Group"
        size="md"
        actions={
          <>
            <button className="btn-secondary" onClick={closeCreateModal} disabled={creating}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
            >
              {creating ? 'Creating...' : 'Create Group'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label">Name</label>
            <input
              className="input"
              placeholder="e.g. Backend Team"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="label">
              Description{' '}
              <span className="text-slate-400 dark:text-zinc-600 font-normal">(optional)</span>
            </label>
            <input
              className="input"
              placeholder="e.g. Access to backend API tokens"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
            />
          </div>
        </div>
      </Modal>

      {/* Group Detail Modal */}
      <Modal
        open={detail !== null || detailLoading}
        onClose={closeDetail}
        title={detail?.name ?? 'Loading...'}
        size="lg"
        actions={
          detail ? (
            <button
              className="btn-ghost p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 mr-auto"
              onClick={() => setDeleteTarget(detail)}
            >
              <Trash2 className="h-4 w-4 inline mr-1" />
              Delete Group
            </button>
          ) : undefined
        }
      >
        {detailLoading ? (
          <div className="text-sm text-slate-500 dark:text-zinc-500">Loading...</div>
        ) : detail ? (
          <div className="space-y-6">
            {/* Editable name */}
            <div>
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input
                    className="input flex-1"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    autoFocus
                  />
                  <button className="btn-primary text-sm" onClick={handleSaveName}>
                    Save
                  </button>
                  <button
                    className="btn-secondary text-sm"
                    onClick={() => {
                      setEditingName(false);
                      setEditName(detail.name);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <h3
                  className="text-lg font-semibold text-slate-900 dark:text-zinc-100 cursor-pointer hover:underline"
                  onClick={() => setEditingName(true)}
                  title="Click to edit"
                >
                  {detail.name}
                </h3>
              )}
            </div>

            {/* Editable description */}
            <div>
              {editingDescription ? (
                <div className="flex items-center gap-2">
                  <input
                    className="input flex-1"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="Add a description..."
                    autoFocus
                  />
                  <button className="btn-primary text-sm" onClick={handleSaveDescription}>
                    Save
                  </button>
                  <button
                    className="btn-secondary text-sm"
                    onClick={() => {
                      setEditingDescription(false);
                      setEditDescription(detail.description ?? '');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <p
                  className="text-sm text-slate-500 dark:text-zinc-500 cursor-pointer hover:underline"
                  onClick={() => setEditingDescription(true)}
                  title="Click to edit"
                >
                  {detail.description || 'No description. Click to add.'}
                </p>
              )}
            </div>

            {/* Members + Tokens side by side */}
            <div className="grid gap-6 md:grid-cols-2">
              {/* Members Section */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                    <UsersRound className="h-4 w-4" />
                    Members
                  </h4>
                  <div className="relative">
                    <button
                      className="btn-ghost text-xs p-1.5 rounded-md"
                      onClick={() => setAddMemberOpen(!addMemberOpen)}
                      title="Add member"
                    >
                      <UserPlus className="h-4 w-4" />
                    </button>
                    {addMemberOpen && (
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
                              onClick={() => handleAddMember(u.id)}
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
                {detail.members.length === 0 ? (
                  <p className="text-xs text-slate-400 dark:text-zinc-600">No members yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {detail.members.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-center justify-between rounded-lg px-3 py-2 bg-slate-50 dark:bg-zinc-800/50"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium text-slate-900 dark:text-zinc-100 truncate">
                            {m.username}
                          </span>
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-zinc-400">
                            {m.role}
                          </span>
                        </div>
                        <button
                          className="btn-ghost p-1 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 flex-shrink-0"
                          title="Remove member"
                          onClick={() => handleRemoveMember(m.id)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Token Access Section */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                    <KeyRound className="h-4 w-4" />
                    Token Access
                  </h4>
                  <div className="relative">
                    <button
                      className="btn-ghost text-xs p-1.5 rounded-md"
                      onClick={() => setGrantTokenOpen(!grantTokenOpen)}
                      title="Grant token"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    {grantTokenOpen && (
                      <div className="absolute right-0 top-full mt-1 z-10 w-56 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-lg max-h-48 overflow-y-auto">
                        {availableTokens.length === 0 ? (
                          <p className="text-xs text-slate-500 dark:text-zinc-500 p-3">
                            No tokens available to grant.
                          </p>
                        ) : (
                          availableTokens.map((t) => (
                            <button
                              key={t.id}
                              className="w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
                              onClick={() => handleGrantToken(t.id)}
                            >
                              {t.name}
                              {t.provider && (
                                <span className="text-slate-400 dark:text-zinc-600 ml-1">
                                  ({t.provider})
                                </span>
                              )}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {detail.tokens.length === 0 ? (
                  <p className="text-xs text-slate-400 dark:text-zinc-600">No tokens granted.</p>
                ) : (
                  <ul className="space-y-1">
                    {detail.tokens.map((t) => (
                      <li
                        key={t.id}
                        className="flex items-center justify-between rounded-lg px-3 py-2 bg-slate-50 dark:bg-zinc-800/50"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium text-slate-900 dark:text-zinc-100 truncate">
                            {t.name}
                          </span>
                          {t.provider && (
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-zinc-400">
                              {t.provider}
                            </span>
                          )}
                        </div>
                        <button
                          className="btn-ghost p-1 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 flex-shrink-0"
                          title="Revoke token access"
                          onClick={() => handleRevokeToken(t.id)}
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
        ) : null}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Group"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}
