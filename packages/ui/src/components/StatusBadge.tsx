import clsx from 'clsx';

type Status = 'active' | 'revoked' | 'pending' | 'approved' | 'denied';

const styles: Record<Status, string> = {
  active:
    'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20',
  revoked:
    'bg-slate-100 text-slate-600 ring-slate-500/10 dark:bg-zinc-700/40 dark:text-zinc-400 dark:ring-zinc-500/20',
  pending:
    'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20',
  approved:
    'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20',
  denied:
    'bg-red-50 text-red-700 ring-red-600/10 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20',
};

interface StatusBadgeProps {
  status: Status;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset capitalize',
        styles[status] ?? styles.pending,
        className,
      )}
    >
      {status}
    </span>
  );
}
