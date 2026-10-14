import { Funnel, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { elementLabel } from '../../model/properties';
import { useStore } from '../../state/store';

export function StatusBar() {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc);
  const hover = useStore((s) => s.hover);
  const selection = useStore((s) => s.selection);
  const navMode = useStore((s) => s.navMode);
  const openDialog = useStore((s) => s.openDialog);

  let message = doc ? t('status.selectHint') : t('status.ready');
  if (navMode === 'pan') message = t('status.panMode');
  else if (navMode === 'orbit') message = t('status.orbitMode');
  else if (navMode === 'zoomRegion') message = t('status.zoomRegion');
  else if (doc && hover !== null) {
    const rec = doc.index.byIndex.get(hover);
    if (rec) message = elementLabel(rec, t);
  }

  const confidence = doc?.diagnostics.confidence;
  return (
    <footer className="statusbar" data-saved-meshes={doc?.savedMeshes.status}>
      <div className="status-message" aria-live="polite">
        {message}
      </div>
      {doc ? (
        <>
          {doc.savedMeshes.status === 'pending' ? (
            <div className="status-item status-busy" title={t('savedMeshes.pendingTitle')}>
              <LoaderCircle size={12} className="spin" />
              <span>{t('savedMeshes.pending')}</span>
            </div>
          ) : null}
          <div className="status-item" title={t('status.revitVersionTitle')}>
            {t('status.revitVersion', { version: doc.summary?.version ?? doc.metadata?.revit_version ?? '?' })}
          </div>
          {confidence ? (
            <button type="button" className="status-item status-button" title={t('command.diagnostics')} onClick={() => openDialog('diagnostics')}>
              {t(`confidence.${confidence.level}`)}
            </button>
          ) : null}
          <button
            type="button"
            className="status-item status-button status-filter"
            title={t('command.filter')}
            disabled={selection.length === 0}
            onClick={() => openDialog('selectionFilter')}
          >
            <Funnel size={12} />
            <span>:{selection.length}</span>
          </button>
        </>
      ) : null}
    </footer>
  );
}
