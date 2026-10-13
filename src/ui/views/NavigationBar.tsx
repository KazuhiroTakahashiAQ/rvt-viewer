import { ChevronDown, Hand, Orbit, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { startZoomRegion, zoomExtents, zoomOut, zoomPrevious, zoomSelection } from '../../app/commands';
import { getViewer } from '../../app/viewerBridge';
import { useStore } from '../../state/store';
import { ContextMenu } from '../common/Menu';

/** Revit's navigation bar: pan / orbit modes and the zoom tools. */
export function NavigationBar({ is3d }: { is3d: boolean }) {
  const { t } = useTranslation();
  const navMode = useStore((s) => s.navMode);
  const hasSelection = useStore((s) => s.selection.length > 0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const toggle = (mode: 'pan' | 'orbit') => getViewer()?.setNavMode(navMode === mode ? 'select' : mode);

  return (
    <div className="nav-bar" role="toolbar" aria-label={t('ui.navigationBar')} aria-orientation="vertical">
      <button
        type="button"
        className={`nav-button${navMode === 'pan' ? ' active' : ''}`}
        aria-pressed={navMode === 'pan'}
        title={t('nav.pan')}
        onClick={() => toggle('pan')}
      >
        <Hand size={16} />
      </button>
      {is3d ? (
        <button
          type="button"
          className={`nav-button${navMode === 'orbit' ? ' active' : ''}`}
          aria-pressed={navMode === 'orbit'}
          title={t('nav.orbit')}
          onClick={() => toggle('orbit')}
        >
          <Orbit size={16} />
        </button>
      ) : null}
      <button
        type="button"
        className={`nav-button${navMode === 'zoomRegion' ? ' active' : ''}`}
        title={t('nav.zoomMenu')}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left - 190, y: r.top });
        }}
      >
        <Search size={16} />
        <ChevronDown size={9} className="nav-caret" />
      </button>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { id: 'region', label: t('command.zoomRegion'), onSelect: startZoomRegion },
            { id: 'out', label: t('command.zoomOut'), onSelect: zoomOut },
            { id: 'fit', label: t('command.zoomExtents'), onSelect: zoomExtents },
            { id: 'sel', label: t('command.zoomSelection'), disabled: !hasSelection, onSelect: zoomSelection },
            { id: 'prev', label: t('command.zoomPrevious'), onSelect: zoomPrevious },
          ]}
        />
      ) : null}
    </div>
  );
}
