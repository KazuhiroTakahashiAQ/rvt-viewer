import { Box, FolderOpen, Info, PanelLeft, SlidersHorizontal, SquareStack } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openDefault3D } from '../../app/commands';
import { pickAndOpen } from '../../app/document';
import { viewFullTitle } from '../../model/browserTree';
import { activeView, useStore } from '../../state/store';

export function TitleBar() {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc);
  const view = useStore(activeView);
  const closeInactive = useStore((s) => s.closeInactiveViews);
  const openDialog = useStore((s) => s.openDialog);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);

  const parts = [t('app.name')];
  if (doc) parts.push(doc.fileName);
  if (doc && view) parts.push(viewFullTitle(view, doc.index, t));

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <span className="app-logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path d="M12 3.5 19.5 7.8v8.4L12 20.5 4.5 16.2V7.8Z" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M4.5 7.8 12 12.1l7.5-4.3M12 12.1v8.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M12 12.1 19.5 7.8v8.4L12 20.5Z" fill="currentColor" fillOpacity="0.55" />
          </svg>
        </span>
        <div className="qat" role="toolbar" aria-label={t('qat.label')}>
          <button type="button" className="qat-button" title={t('command.open')} onClick={() => void pickAndOpen()}>
            <FolderOpen size={16} />
          </button>
          <span className="qat-separator" />
          <button type="button" className="qat-button" title={t('command.default3D')} disabled={!doc} onClick={openDefault3D}>
            <Box size={16} />
          </button>
          <button type="button" className="qat-button" title={t('command.closeInactive')} disabled={!doc} onClick={closeInactive}>
            <SquareStack size={16} />
          </button>
          <span className="qat-separator" />
          <button
            type="button"
            className={`qat-button${prefs.showProperties ? ' on' : ''}`}
            title={t('ui.properties')}
            aria-pressed={prefs.showProperties}
            onClick={() => setPrefs({ showProperties: !prefs.showProperties })}
          >
            <SlidersHorizontal size={16} />
          </button>
          <button
            type="button"
            className={`qat-button${prefs.showBrowser ? ' on' : ''}`}
            title={t('ui.projectBrowser')}
            aria-pressed={prefs.showBrowser}
            onClick={() => setPrefs({ showBrowser: !prefs.showBrowser })}
          >
            <PanelLeft size={16} />
          </button>
        </div>
      </div>
      <div className="titlebar-title" title={parts.join(' - ')}>
        {parts.join(' - ')}
      </div>
      <div className="titlebar-right">
        <button type="button" className="qat-button" title={t('command.about')} onClick={() => openDialog('about')}>
          <Info size={16} />
        </button>
      </div>
    </header>
  );
}
