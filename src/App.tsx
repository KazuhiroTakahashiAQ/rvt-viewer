import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openDataTransfer } from './app/document';
import { getViewer } from './app/viewerBridge';
import { useStore } from './state/store';
import { Dialogs } from './ui/dialogs/Dialogs';
import { HomeScreen } from './ui/home/HomeScreen';
import { LoadingOverlay } from './ui/home/LoadingOverlay';
import { Dock } from './ui/shell/Dock';
import { Ribbon } from './ui/shell/Ribbon';
import { StatusBar } from './ui/shell/StatusBar';
import { TitleBar } from './ui/shell/TitleBar';
import { Toasts } from './ui/shell/Toasts';
import { useApplyTheme } from './ui/useTheme';
import { ViewArea } from './ui/views/ViewArea';

export function App() {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc);
  const showStatusBar = useStore((s) => s.prefs.showStatusBar);
  const [dragging, setDragging] = useState(false);
  useApplyTheme();

  // Esc: leave a navigation mode, then clear the selection (as in Revit).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || ev.defaultPrevented) return;
      const target = ev.target as HTMLElement | null;
      if (target?.closest('input, select, textarea, [role="dialog"], .menu')) return;
      const s = useStore.getState();
      if (s.dialog || s.appMenuOpen) return;
      if (s.navMode !== 'select') getViewer()?.setNavMode('select');
      else if (s.selection.length) s.clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');

  return (
    <div
      className="app"
      onDragEnter={(e) => {
        if (hasFiles(e)) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        void openDataTransfer(e.dataTransfer);
      }}
    >
      <TitleBar />
      <Ribbon />
      <div className="workspace">
        {doc ? <Dock /> : null}
        {doc ? <ViewArea /> : <HomeScreen />}
      </div>
      {showStatusBar ? <StatusBar /> : null}
      <LoadingOverlay />
      <Dialogs />
      <Toasts />
      {dragging ? (
        <div className="drop-overlay" aria-hidden="true">
          <div>{t('home.dropHere')}</div>
        </div>
      ) : null}
    </div>
  );
}
