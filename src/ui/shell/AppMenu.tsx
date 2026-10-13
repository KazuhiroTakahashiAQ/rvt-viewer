import { ChevronRight, Download, FileText, FolderOpen, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { closeDocument, exportDocument, openRecent, pickAndOpen } from '../../app/document';
import { currentLocale } from '../../i18n';
import { listRecentFiles, type RecentFile } from '../../pwa/recentFiles';
import { useStore } from '../../state/store';
import type { ExportKind } from '../../worker/protocol';

type Pane = 'recent' | 'export';

export function AppMenu({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc);
  const openDialog = useStore((s) => s.openDialog);
  const [pane, setPane] = useState<Pane>('recent');
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void listRecentFiles().then(setRecent);
  }, []);

  useEffect(() => {
    const onDown = (ev: PointerEvent) => {
      const target = ev.target as HTMLElement;
      if (!ref.current?.contains(target) && !target.closest('.ribbon-file-tab')) onClose();
    };
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const exports: [ExportKind | 'diagnostics', string, string][] = [
    ['ifc', t('export.ifc'), t('export.ifcHint')],
    ['glb', t('export.glb'), t('export.glbHint')],
    ['plan-svg', t('export.planSvg'), t('export.planSvgHint')],
    ['csv-elements', t('export.csvElements'), t('export.csvHint')],
    ['csv-rooms', t('export.csvRooms'), t('export.csvHint')],
    ['diagnostics', t('export.diagnostics'), t('export.diagnosticsHint')],
  ];
  const dateFmt = new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div ref={ref} className="app-menu" role="menu">
      <div className="app-menu-main">
        <div className="app-menu-commands">
          <button
            type="button"
            className="app-menu-item"
            onClick={() => {
              onClose();
              void pickAndOpen();
            }}
          >
            <FolderOpen size={22} />
            <span>{t('command.open')}</span>
          </button>
          <button
            type="button"
            className={`app-menu-item${pane === 'export' ? ' active' : ''}`}
            disabled={!doc}
            onMouseEnter={() => doc && setPane('export')}
            onClick={() => setPane('export')}
          >
            <Download size={22} />
            <span>{t('command.export')}</span>
            <ChevronRight size={14} className="app-menu-arrow" />
          </button>
          <button
            type="button"
            className="app-menu-item"
            disabled={!doc}
            onMouseEnter={() => setPane('recent')}
            onClick={() => {
              onClose();
              closeDocument();
            }}
          >
            <X size={22} />
            <span>{t('command.close')}</span>
          </button>
        </div>
        <div className="app-menu-pane">
          {pane === 'export' && doc ? (
            <>
              <div className="app-menu-pane-title">{t('export.title')}</div>
              {exports.map(([kind, label, hint]) => (
                <button
                  key={kind}
                  type="button"
                  className="app-menu-pane-item"
                  disabled={kind === 'csv-rooms' && !doc.index.categories.some((c) => c.key === 'rooms')}
                  onClick={() => {
                    onClose();
                    void exportDocument(kind);
                  }}
                >
                  <FileText size={18} />
                  <span>
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </span>
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="app-menu-pane-title">{t('recent.title')}</div>
              {recent.length === 0 ? <p className="app-menu-empty">{t('recent.empty')}</p> : null}
              {recent.map((r) => (
                <button
                  key={`${r.name}-${r.openedAt}`}
                  type="button"
                  className="app-menu-pane-item"
                  onClick={() => {
                    onClose();
                    void openRecent(r);
                  }}
                >
                  <FileText size={18} />
                  <span>
                    <strong>{r.name}</strong>
                    <small>{dateFmt.format(r.openedAt)}</small>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
      <div className="app-menu-footer">
        <button type="button" className="button" onClick={() => openDialog('options')}>
          <SlidersHorizontal size={14} />
          {t('command.options')}
        </button>
      </div>
    </div>
  );
}
