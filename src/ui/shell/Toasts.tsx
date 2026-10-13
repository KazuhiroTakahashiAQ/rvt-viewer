import { X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { updateApp } from '../../pwa/registerSW';
import { type Toast, useStore } from '../../state/store';

function ToastItem({ toast }: { toast: Toast }) {
  const { t } = useTranslation();
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    if (toast.kind === 'update') return;
    const id = window.setTimeout(() => dismiss(toast.id), toast.kind === 'error' ? 8000 : 4000);
    return () => window.clearTimeout(id);
  }, [toast, dismiss]);
  return (
    <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <span>{toast.message}</span>
      {toast.kind === 'update' ? (
        <button type="button" className="button small primary" onClick={() => void updateApp()}>
          {t('pwa.reload')}
        </button>
      ) : null}
      <button type="button" className="icon-button" aria-label={t('common.close')} onClick={() => dismiss(toast.id)}>
        <X size={13} />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
