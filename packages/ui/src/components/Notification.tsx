import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import clsx from 'clsx';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotificationType = 'success' | 'error' | 'info';

interface Notification {
  id: number;
  type: NotificationType;
  message: string;
}

interface NotificationContextValue {
  notify: (type: NotificationType, message: string) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const NotificationContext = createContext<NotificationContextValue>({
  notify: () => {},
});

export const useNotification = () => useContext(NotificationContext);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let nextId = 0;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Notification[]>([]);

  const notify = useCallback((type: NotificationType, message: string) => {
    const id = ++nextId;
    setItems((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((n) => n.id !== id));
    }, 4000);
  }, []);

  const dismiss = (id: number) =>
    setItems((prev) => prev.filter((n) => n.id !== id));

  return (
    <NotificationContext.Provider value={{ notify }}>
      {children}
      {/* Toast container */}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {items.map((n) => (
          <Toast key={n.id} notification={n} onDismiss={() => dismiss(n.id)} />
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

const iconMap = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
};

const colorMap = {
  success:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300',
  error:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-500/10 dark:text-red-300',
  info: 'border-brand-200 bg-brand-50 text-brand-800 dark:border-brand-800 dark:bg-brand-500/10 dark:text-brand-300',
};

function Toast({
  notification,
  onDismiss,
}: {
  notification: Notification;
  onDismiss: () => void;
}) {
  const Icon = iconMap[notification.type];
  return (
    <div
      className={clsx(
        'pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg text-sm min-w-[300px] max-w-md animate-[slideIn_0.2s_ease-out]',
        colorMap[notification.type],
      )}
    >
      <Icon className="h-5 w-5 flex-shrink-0" />
      <span className="flex-1">{notification.message}</span>
      <button onClick={onDismiss} className="flex-shrink-0 opacity-60 hover:opacity-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
