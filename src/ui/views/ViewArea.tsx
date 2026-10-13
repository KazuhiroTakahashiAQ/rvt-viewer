import { Box, Grid3x3, Table2, View, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { viewFullTitle } from '../../model/browserTree';
import { useStore } from '../../state/store';
import { ModelViewHost } from './ModelViewHost';
import { NavigationBar } from './NavigationBar';
import { ScheduleView } from './ScheduleView';
import { ViewControlBar } from './ViewControlBar';

function TabIcon({ kind }: { kind: string }) {
  switch (kind) {
    case 'plan':
      return <Grid3x3 size={12} />;
    case '3d':
      return <Box size={12} />;
    case 'elevation':
      return <View size={12} />;
    default:
      return <Table2 size={12} />;
  }
}

export function ViewArea() {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc)!;
  const views = useStore((s) => s.views);
  const openViews = useStore((s) => s.openViews);
  const activeViewId = useStore((s) => s.activeViewId);
  const activate = useStore((s) => s.activateView);
  const closeView = useStore((s) => s.closeView);
  const showNavBar = useStore((s) => s.prefs.showNavBar);

  const active = views.find((v) => v.id === activeViewId);
  const isModel = !!active && active.kind !== 'schedule';

  return (
    <main className="view-area">
      <div className="view-tabs" role="tablist" aria-label={t('ui.openViews')}>
        {openViews.map((id) => {
          const v = views.find((x) => x.id === id);
          if (!v) return null;
          const title = viewFullTitle(v, doc.index, t);
          return (
            <div
              key={id}
              role="tab"
              aria-selected={id === activeViewId}
              tabIndex={0}
              className={`view-tab${id === activeViewId ? ' active' : ''}`}
              title={title}
              onClick={() => activate(id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && activate(id)}
              onAuxClick={(e) => e.button === 1 && closeView(id)}
            >
              <TabIcon kind={v.kind} />
              <span className="view-tab-label">{title}</span>
              <button
                type="button"
                className="view-tab-close"
                aria-label={t('common.closeView', { name: title })}
                onClick={(e) => {
                  e.stopPropagation();
                  closeView(id);
                }}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="view-content">
        {doc.hasGeometry ? <ModelViewHost visible={isModel} /> : null}
        {isModel && !doc.hasGeometry ? <div className="view-empty">{t('view.noGeometry')}</div> : null}
        {active?.kind === 'schedule' ? <ScheduleView key={active.id} kind={active.schedule ?? 'elements'} /> : null}
        {!active ? <div className="view-empty">{t('view.noOpenView')}</div> : null}
        {isModel && doc.hasGeometry && showNavBar ? <NavigationBar is3d={active?.kind === '3d'} /> : null}
      </div>
      {isModel ? <ViewControlBar /> : null}
    </main>
  );
}
