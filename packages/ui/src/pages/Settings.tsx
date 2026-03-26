import { useState, useEffect, useRef, useCallback } from 'react';
import { Download, RefreshCw, Shield, Info, Fingerprint, Check, Upload, AlertTriangle, Trash2, Plus } from 'lucide-react';
import { auth, ca, proxyAcls, type ProxyAcl } from '../lib/api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useNotification } from '../components/Notification';

export function SettingsPage() {
  const { notify } = useNotification();
  const [downloading, setDownloading] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [hasPasskey, setHasPasskey] = useState<boolean | null>(null);
  const [registeringPasskey, setRegisteringPasskey] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadCert, setUploadCert] = useState('');
  const [uploadKey, setUploadKey] = useState('');
  const certFileRef = useRef<HTMLInputElement>(null);
  const keyFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    auth.hasPasskey()
      .then(({ hasPasskey: v }) => setHasPasskey(v))
      .catch(() => setHasPasskey(null));
  }, []);

  const handleRegisterPasskey = async () => {
    setRegisteringPasskey(true);
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');
      const { options } = await auth.registerPasskeyOptions();
      const attestation = await startRegistration({ optionsJSON: options as any });
      await auth.registerPasskeyVerify(attestation);
      setHasPasskey(true);
      notify('success', 'Passkey registered successfully! You can now sign in with it.');
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        notify('error', 'Passkey registration was cancelled.');
      } else {
        notify('error', err?.message ?? 'Failed to register passkey.');
      }
    } finally {
      setRegisteringPasskey(false);
    }
  };

  const readFile = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(file);
    });

  const handleUploadCA = async () => {
    if (!uploadCert.trim() || !uploadKey.trim()) {
      notify('error', 'Both certificate and private key are required.');
      return;
    }
    setUploading(true);
    try {
      const result = await ca.upload(uploadCert.trim(), uploadKey.trim());
      notify('success', `CA "${result.subject}" uploaded. Expires ${new Date(result.expiresAt).toLocaleDateString()}.`);
      setShowUpload(false);
      setUploadCert('');
      setUploadKey('');
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to upload CA.');
    } finally {
      setUploading(false);
    }
  };

  // -- Proxy ACL state ---------------------------------------------------------
  const [aclMode, setAclMode] = useState<'open' | 'restricted'>('open');
  const [aclRules, setAclRules] = useState<ProxyAcl[]>([]);
  const [aclLoading, setAclLoading] = useState(true);
  const [newPattern, setNewPattern] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [addingRule, setAddingRule] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  const loadAcls = useCallback(async () => {
    try {
      const [statusRes, listRes] = await Promise.all([
        proxyAcls.status(),
        proxyAcls.list(),
      ]);
      setAclMode(statusRes.mode);
      setAclRules(listRes.rules);
    } catch {
      // ignore
    } finally {
      setAclLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAcls();
  }, [loadAcls]);

  const handleAddRule = async () => {
    if (!newPattern.trim()) return;
    setAddingRule(true);
    try {
      await proxyAcls.create({
        servicePattern: newPattern.trim(),
        description: newDescription.trim() || undefined,
      });
      notify('success', `ACL rule "${newPattern.trim()}" added.`);
      setNewPattern('');
      setNewDescription('');
      loadAcls();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to add rule.');
    } finally {
      setAddingRule(false);
    }
  };

  const handleDeleteRule = async (rule: ProxyAcl) => {
    setDeletingRuleId(rule.id);
    try {
      await proxyAcls.delete(rule.id);
      notify('success', `Rule "${rule.servicePattern}" deleted.`);
      loadAcls();
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to delete rule.');
    } finally {
      setDeletingRuleId(null);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const pem = await ca.download();
      // Trigger a file download
      const blob = new Blob([pem], { type: 'application/x-pem-file' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'overbearer-ca.pem';
      a.click();
      URL.revokeObjectURL(url);
      notify('success', 'CA certificate downloaded.');
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to download certificate.');
    } finally {
      setDownloading(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await ca.generate();
      notify('success', 'New CA certificate generated. Services will need to trust the new certificate.');
      setShowGenerate(false);
    } catch (err: any) {
      notify('error', err?.message ?? 'Failed to generate certificate.');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">
          Settings
        </h1>
        <p className="text-sm text-slate-500 dark:text-zinc-500 mt-1">
          System configuration and CA management.
        </p>
      </div>

      {/* CA Certificate */}
      <div className="card">
        <div className="flex items-center gap-3 border-b border-slate-200 dark:border-zinc-800 px-5 py-4">
          <Shield className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            CA Certificate
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-600 dark:text-zinc-400">
            The CA certificate is used by the MITM proxy to generate per-host
            TLS certificates on the fly. Services must trust this CA for
            transparent token replacement to work.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              className="btn-primary"
              onClick={handleDownload}
              disabled={downloading}
            >
              <Download className="h-4 w-4" />
              {downloading ? 'Downloading...' : 'Download CA Certificate'}
            </button>
            <button
              className="btn-danger"
              onClick={() => setShowGenerate(true)}
            >
              <RefreshCw className="h-4 w-4" />
              Generate New CA
            </button>
            <button
              className="btn-secondary"
              onClick={() => setShowUpload((v) => !v)}
            >
              <Upload className="h-4 w-4" />
              Upload Custom CA
            </button>
          </div>

          {/* Upload CA form */}
          {showUpload && (
            <div className="mt-4 space-y-4 rounded-lg border border-slate-200 dark:border-zinc-700 p-4 bg-slate-50 dark:bg-zinc-800/50">
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                Upload your own CA certificate and private key in PEM format.
                The key will be encrypted at rest.
              </p>
              <div>
                <label className="label">CA Certificate (PEM)</label>
                <div className="flex gap-2 mb-1">
                  <input
                    ref={certFileRef}
                    type="file"
                    accept=".pem,.crt,.cer"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) setUploadCert(await readFile(file));
                    }}
                  />
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => certFileRef.current?.click()}
                  >
                    Choose file...
                  </button>
                </div>
                <textarea
                  className="input font-mono text-xs h-28"
                  placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                  value={uploadCert}
                  onChange={(e) => setUploadCert(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Private Key (PEM)</label>
                <div className="flex gap-2 mb-1">
                  <input
                    ref={keyFileRef}
                    type="file"
                    accept=".pem,.key"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) setUploadKey(await readFile(file));
                    }}
                  />
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => keyFileRef.current?.click()}
                  >
                    Choose file...
                  </button>
                </div>
                <textarea
                  className="input font-mono text-xs h-28"
                  placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
                  value={uploadKey}
                  onChange={(e) => setUploadKey(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <button
                  className="btn-primary"
                  onClick={handleUploadCA}
                  disabled={uploading || !uploadCert.trim() || !uploadKey.trim()}
                >
                  {uploading ? 'Uploading...' : 'Upload CA'}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => { setShowUpload(false); setUploadCert(''); setUploadKey(''); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Proxy Access Control */}
      <div className="card">
        <div className="flex items-center gap-3 border-b border-slate-200 dark:border-zinc-800 px-5 py-4">
          <Shield className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            Proxy Access Control
          </h2>
          {!aclLoading && (
            aclMode === 'open' ? (
              <span className="ml-auto inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                Open
              </span>
            ) : (
              <span className="ml-auto inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400">
                Restricted
              </span>
            )
          )}
        </div>
        <div className="p-5 space-y-4">
          {aclLoading ? (
            <p className="text-sm text-slate-500 dark:text-zinc-500">Loading...</p>
          ) : (
            <>
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                {aclMode === 'open'
                  ? 'The proxy accepts connections from any service. Add rules below to restrict access.'
                  : 'The proxy only accepts connections from services matching the rules below.'}
              </p>

              {aclMode === 'open' && (
                <div className="flex items-start gap-3 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4">
                  <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-sm text-amber-800 dark:text-amber-300">
                    The proxy is currently open — any service can use it. If the proxy is accessible
                    from the internet, this means anyone can route traffic through Overbearer. Add ACL
                    rules below to restrict access, or ensure the proxy is only reachable from your
                    private network.
                  </p>
                </div>
              )}

              {/* Rule list */}
              {aclRules.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-zinc-700">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-zinc-800/50 text-left text-xs font-medium text-slate-500 dark:text-zinc-500">
                        <th className="px-4 py-2">Pattern</th>
                        <th className="px-4 py-2">Description</th>
                        <th className="px-4 py-2">Created</th>
                        <th className="px-4 py-2 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-zinc-700">
                      {aclRules.map((rule) => (
                        <tr key={rule.id} className="text-slate-700 dark:text-zinc-300">
                          <td className="px-4 py-2">
                            <code className="text-xs font-mono bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                              {rule.servicePattern}
                            </code>
                          </td>
                          <td className="px-4 py-2 text-slate-500 dark:text-zinc-500">
                            {rule.description || '—'}
                          </td>
                          <td className="px-4 py-2 text-slate-500 dark:text-zinc-500 tabular-nums">
                            {new Date(rule.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-2">
                            <button
                              className="btn-ghost p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                              title="Delete rule"
                              disabled={deletingRuleId === rule.id}
                              onClick={() => handleDeleteRule(rule)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {aclRules.length === 0 && (
                <p className="text-sm text-slate-400 dark:text-zinc-600">
                  No ACL rules configured.
                </p>
              )}

              {/* Add rule form */}
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  className="input flex-1"
                  placeholder="e.g., production/*, 10.0.0.0/16"
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                />
                <input
                  className="input flex-1"
                  placeholder="Description (optional)"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                />
                <button
                  className="btn-primary shrink-0"
                  onClick={handleAddRule}
                  disabled={addingRule || !newPattern.trim()}
                >
                  <Plus className="h-4 w-4" />
                  {addingRule ? 'Adding...' : 'Add Rule'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Passkey Management */}
      <div className="card">
        <div className="flex items-center gap-3 border-b border-slate-200 dark:border-zinc-800 px-5 py-4">
          <Fingerprint className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            Passkey Authentication
          </h2>
        </div>
        <div className="p-5 space-y-4">
          {hasPasskey === null ? (
            <p className="text-sm text-slate-500 dark:text-zinc-500">Loading...</p>
          ) : hasPasskey ? (
            <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <Check className="h-4 w-4" />
              <span>Passkey registered. You can sign in with your passkey.</span>
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                You don't have a passkey registered yet. Register one to enable
                secure, passwordless sign-in for future sessions.
              </p>
              <button
                className="btn-primary"
                onClick={handleRegisterPasskey}
                disabled={registeringPasskey}
              >
                <Fingerprint className="h-4 w-4" />
                {registeringPasskey ? 'Registering...' : 'Register Passkey'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* System info */}
      <div className="card">
        <div className="flex items-center gap-3 border-b border-slate-200 dark:border-zinc-800 px-5 py-4">
          <Info className="h-5 w-5 text-slate-400 dark:text-zinc-500" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            System Information
          </h2>
        </div>
        <div className="p-5">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <div>
              <dt className="text-slate-500 dark:text-zinc-500">Product</dt>
              <dd className="font-medium text-slate-900 dark:text-zinc-100 mt-0.5">
                Overbearer
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-zinc-500">UI Version</dt>
              <dd className="font-mono text-slate-900 dark:text-zinc-100 mt-0.5">
                1.0.0
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-zinc-500">
                Architecture
              </dt>
              <dd className="font-medium text-slate-900 dark:text-zinc-100 mt-0.5">
                MITM Proxy + Management API + UI
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-zinc-500">
                Authentication
              </dt>
              <dd className="font-medium text-slate-900 dark:text-zinc-100 mt-0.5">
                WebAuthn / FIDO2 Passkeys
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Generate CA confirmation */}
      <ConfirmDialog
        open={showGenerate}
        onClose={() => setShowGenerate(false)}
        onConfirm={handleGenerate}
        title="Generate New CA"
        message="This will replace the current CA certificate and private key. All existing per-host certificates will become invalid. Services will need to trust the new CA. This action cannot be undone."
        confirmLabel="Generate"
        loading={generating}
      />
    </div>
  );
}
