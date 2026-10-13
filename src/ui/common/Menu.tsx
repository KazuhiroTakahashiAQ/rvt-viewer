import { Check, ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  id: string;
  label?: string;
  icon?: ReactNode;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  onSelect?: () => void;
  submenu?: MenuItem[];
}

interface MenuListProps {
  items: MenuItem[];
  onClose: () => void;
  x: number;
  y: number;
  level?: number;
}

function MenuList({ items, onClose, x, y, level = 0 }: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<{ id: string; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const ny = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    if (level === 0) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [level]);

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} className="menu-separator" role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={item.disabled}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            onMouseEnter={(e) => {
              if (item.submenu && !item.disabled) {
                const r = e.currentTarget.getBoundingClientRect();
                setOpenSub({ id: item.id, x: r.right - 2, y: r.top - 4 });
              } else {
                setOpenSub(null);
              }
            }}
            onClick={(e) => {
              if (item.submenu) {
                const r = e.currentTarget.getBoundingClientRect();
                setOpenSub({ id: item.id, x: r.right - 2, y: r.top - 4 });
                return;
              }
              item.onSelect?.();
              onClose();
            }}
          >
            <span className="menu-check">{item.checked ? <Check size={13} /> : item.icon}</span>
            <span className="menu-label">{item.label}</span>
            {item.submenu ? <ChevronRight size={13} className="menu-arrow" /> : null}
          </button>
        ),
      )}
      {openSub
        ? (() => {
            const sub = items.find((i) => i.id === openSub.id)?.submenu;
            return sub ? <MenuList items={sub} onClose={onClose} x={openSub.x} y={openSub.y} level={level + 1} /> : null;
          })()
        : null}
    </div>
  );
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  useEffect(() => {
    const onDown = (ev: PointerEvent) => {
      if (!(ev.target as HTMLElement).closest('.menu')) onClose();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onBlur);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onBlur);
      window.removeEventListener('blur', onBlur);
    };
  }, [onClose]);
  return createPortal(<MenuList items={items} onClose={onClose} x={x} y={y} />, document.body);
}
