import { X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../state/store';
import { ProjectBrowser } from '../browser/ProjectBrowser';
import { PropertiesPalette } from '../properties/PropertiesPalette';

function PaletteFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="palette" aria-label={title}>
      <header className="palette-header">
        <span>{title}</span>
        <button type="button" className="icon-button" aria-label={t('common.closePalette', { name: title })} onClick={onClose}>
          <X size={13} />
        </button>
      </header>
      <div className="palette-body">{children}</div>
    </section>
  );
}

/** Left dock: Properties above, Project Browser below (Revit's default layout). */
export function Dock() {
  const { t } = useTranslation();
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const dockRef = useRef<HTMLDivElement>(null);

  if (!prefs.showProperties && !prefs.showBrowser) return null;
  const both = prefs.showProperties && prefs.showBrowser;

  const startResizeWidth = (ev: React.PointerEvent) => {
    const startX = ev.clientX;
    const startW = prefs.dockWidth;
    const el = ev.currentTarget as HTMLElement;
    el.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      setPrefs({ dockWidth: Math.round(Math.min(Math.max(startW + e.clientX - startX, 200), window.innerWidth * 0.6)) });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const startResizeSplit = (ev: React.PointerEvent) => {
    const dock = dockRef.current;
    if (!dock) return;
    const rect = dock.getBoundingClientRect();
    const el = ev.currentTarget as HTMLElement;
    el.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      setPrefs({ dockSplit: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0.15), 0.85) });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <aside ref={dockRef} className="dock" style={{ width: prefs.dockWidth }}>
      {prefs.showProperties ? (
        <div className="dock-slot" style={both ? { flexBasis: `${prefs.dockSplit * 100}%` } : { flex: 1 }}>
          <PaletteFrame title={t('ui.properties')} onClose={() => setPrefs({ showProperties: false })}>
            <PropertiesPalette />
          </PaletteFrame>
        </div>
      ) : null}
      {both ? (
        <div
          className="dock-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('ui.resizePalettes')}
          onPointerDown={startResizeSplit}
        />
      ) : null}
      {prefs.showBrowser ? (
        <div className="dock-slot" style={{ flex: 1 }}>
          <PaletteFrame title={t('ui.projectBrowserTitle')} onClose={() => setPrefs({ showBrowser: false })}>
            <ProjectBrowser />
          </PaletteFrame>
        </div>
      ) : null}
      <div className="dock-resizer" role="separator" aria-orientation="vertical" aria-label={t('ui.resizeDock')} onPointerDown={startResizeWidth} />
    </aside>
  );
}
