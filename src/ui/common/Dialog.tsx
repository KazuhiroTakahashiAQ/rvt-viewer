import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}

/** Modal dialog with a draggable title bar, like Revit's dialogs. */
export function Dialog({ title, onClose, children, footer, width = 520, className }: DialogProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, button.primary, button')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`dialog ${className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width, transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        <div
          className="dialog-title"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <span>{title}</span>
          <button type="button" className="icon-button" aria-label={t('common.close')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
