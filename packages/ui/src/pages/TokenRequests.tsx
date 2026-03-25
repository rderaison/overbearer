import { useEffect, useState, useCallback } from 'react';
import { Plus, Check, X as XIcon } from 'lucide-react';
import {
  tokenRequests,
  type TokenRequest,
} from '../lib/api';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { Modal } from '../components/Modal';
import { useNotification } from '../components/Notification';

// ---------------------------------------------------------------------------
// New Request Modal (requester)
// ---------------------------------------------------------------------------

function NewRequestModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { notify } = useNotification();
  const [provider, setProvider] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setProvider('');
    setReason('');
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      await tokenRequests.create({ provider, reason });
      notify('success', 'Token request submitted.');
      reset();
      onCreated();
      onClose();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to submit request.');
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
      title="Request a Token"
      actions={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={loading || !provider.trim() || !reason.trim()}
          >
            {loading ? 'Submitting...' : 'Submit Request'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label">Provider</label>
          <select
            className="input"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">Select a provider...</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="github">GitHub</option>
            <option value="aws">AWS</option>
            <option value="gcp">GCP</option>
            <option value="azure">Azure</option>
            <option value="stripe">Stripe</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label className="label">Reason</label>
          <textarea
            className="input min-h-[80px] resize-y"
            placeholder="Describe why you need this token and how it will be used..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Approve Modal (manager)
// ---------------------------------------------------------------------------

function ApproveModal({
  open,
  onClose,
  request,
  onApproved,
}: {
  open: boolean;
  onClose: () => void;
  request: TokenRequest | null;
  onApproved: () => void;
}) {
  const { notify } = useNotification();
  const [name, setName] = useState('');
  const [realToken, setRealToken] = useState('');
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setName('');
    setRealToken('');
  };

  const handleApprove = async () => {
    if (!request) return;
    setLoading(true);
    try {
      await tokenRequests.approve(request.id, { name, realToken });
      notify('success', 'Request approved and token created.');
      reset();
      onApproved();
      onClose();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to approve request.');
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
      title="Approve Request"
      actions={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleApprove}
            disabled={loading || !name.trim() || !realToken.trim()}
          >
            {loading ? 'Approving...' : 'Approve & Create Token'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 dark:bg-zinc-800/50 p-3 text-sm">
          <p className="text-slate-500 dark:text-zinc-500 text-xs mb-1">
            Request from{' '}
            <span className="font-medium text-slate-700 dark:text-zinc-300">
              {request?.requestedByUsername ?? request?.requestedBy}
            </span>{' '}
            for{' '}
            <span className="font-medium text-slate-700 dark:text-zinc-300 capitalize">
              {request?.provider}
            </span>
          </p>
          <p className="text-slate-600 dark:text-zinc-400">{request?.reason}</p>
        </div>
        <div>
          <label className="label">Token Name</label>
          <input
            className="input"
            placeholder="e.g. Team OpenAI key"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function TokenRequests() {
  const { notify } = useNotification();
  const [data, setData] = useState<TokenRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNew, setShowNew] = useState(false);
  const [approveTarget, setApproveTarget] = useState<TokenRequest | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await tokenRequests.list();
      setData(res.requests);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDeny = async (req: TokenRequest) => {
    try {
      await tokenRequests.deny(req.id);
      notify('success', 'Request denied.');
      load();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to deny request.');
    }
  };

  const columns: Column<TokenRequest>[] = [
    {
      key: 'provider',
      header: 'Provider',
      sortable: true,
      render: (r) => (
        <span className="capitalize font-medium">{r.provider}</span>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (r) => (
        <span className="max-w-xs truncate block text-slate-600 dark:text-zinc-400">
          {r.reason}
        </span>
      ),
    },
    {
      key: 'requestedByUsername',
      header: 'Requested By',
      sortable: true,
      render: (r) => r.requestedByUsername ?? r.requestedBy,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: 'createdAt',
      header: 'Submitted',
      sortable: true,
      render: (r) => new Date(r.createdAt).toLocaleString(),
    },
    {
      key: 'reviewedByUsername',
      header: 'Reviewed By',
      render: (r) =>
        r.reviewedByUsername ?? r.reviewedBy ?? (
          <span className="text-slate-400 dark:text-zinc-600">--</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        r.status === 'pending' ? (
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost p-1.5 rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
              title="Approve"
              onClick={(e) => {
                e.stopPropagation();
                setApproveTarget(r);
              }}
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              className="btn-ghost p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
              title="Deny"
              onClick={(e) => {
                e.stopPropagation();
                handleDeny(r);
              }}
            >
              <XIcon className="h-4 w-4" />
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
            Token Requests
          </h1>
          <p className="text-sm text-slate-500 dark:text-zinc-500 mt-1">
            Request new tokens or review pending requests.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowNew(true)}>
          <Plus className="h-4 w-4" />
          New Request
        </button>
      </div>

      <DataTable
        columns={columns}
        data={data}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage="No token requests."
      />

      <NewRequestModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={load}
      />

      <ApproveModal
        open={approveTarget !== null}
        onClose={() => setApproveTarget(null)}
        request={approveTarget}
        onApproved={load}
      />
    </div>
  );
}
