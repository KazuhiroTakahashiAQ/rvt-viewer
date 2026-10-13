import { Cuboid, Glasses, Lightbulb, Box, Square, SquareDashed, PaintBucket } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyTempToView, toggleSectionBox } from '../../app/commands';
import type { VisualStyle } from '../../engine/modelMaterials';
import { activeSettings, activeView, useStore } from '../../state/store';
import { ContextMenu, type MenuItem } from '../common/Menu';

const STYLE_ICONS: Record<VisualStyle, ReactNode> = {
  wireframe: <SquareDashed size={15} />,
  hiddenLine: <Square size={15} />,
  shaded: <Box size={15} />,
  consistentColors: <PaintBucket size={15} />,
};

/** Bottom-of-view control bar (表示スタイル, 一時的に非表示/分離, 非表示要素を一時表示…). */
export function ViewControlBar() {
  const { t } = useTranslation();
  const view = useStore(activeView);
  const settings = useStore(activeSettings);
  const update = useStore((s) => s.updateViewSettings);
  const hasSelection = useStore((s) => s.selection.length > 0);
  const tempHideIsolate = useStore((s) => s.tempHideIsolate);
  const resetTemp = useStore((s) => s.resetTemp);
  const toggleReveal = useStore((s) => s.toggleReveal);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  if (!view || !settings) return null;

  const open = (e: React.MouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.top - 8 - items.length * 26, items });
  };

  const styles: VisualStyle[] = ['wireframe', 'hiddenLine', 'shaded', 'consistentColors'];
  const tempItems: MenuItem[] = [
    { id: 'isoCat', label: t('command.isolateCategory'), disabled: !hasSelection, onSelect: () => tempHideIsolate('isolate', 'category') },
    { id: 'hideCat', label: t('command.hideCategory'), disabled: !hasSelection, onSelect: () => tempHideIsolate('hide', 'category') },
    { id: 'isoEl', label: t('command.isolateElements'), disabled: !hasSelection, onSelect: () => tempHideIsolate('isolate', 'elements') },
    { id: 'hideEl', label: t('command.hideElements'), disabled: !hasSelection, onSelect: () => tempHideIsolate('hide', 'elements') },
    { id: 'sep', separator: true },
    { id: 'reset', label: t('command.resetTemp'), disabled: settings.tempMode === 'none', onSelect: resetTemp },
    { id: 'apply', label: t('command.applyTempToView'), disabled: settings.tempMode === 'none', onSelect: applyTempToView },
  ];

  return (
    <div className="view-control-bar" role="toolbar" aria-label={t('ui.viewControlBar')}>
      {view.kind !== '3d' ? <span className="vcb-scale">{t('vcb.scale', { scale: 100 })}</span> : null}
      <button
        type="button"
        className="vcb-button"
        title={t('vcb.visualStyle', { style: t(`visualStyle.${settings.visualStyle}`) })}
        onClick={(e) =>
          open(
            e,
            styles.map((s) => ({
              id: s,
              label: t(`visualStyle.${s}`),
              checked: settings.visualStyle === s,
              onSelect: () => update(view.id, { visualStyle: s }),
            })),
          )
        }
      >
        {STYLE_ICONS[settings.visualStyle]}
      </button>
      {view.kind === '3d' ? (
        <button
          type="button"
          className={`vcb-button${settings.sectionBox.enabled ? ' active' : ''}`}
          aria-pressed={settings.sectionBox.enabled}
          title={t('command.sectionBox')}
          onClick={toggleSectionBox}
        >
          <Cuboid size={15} />
        </button>
      ) : null}
      <span className="vcb-separator" />
      <button
        type="button"
        className={`vcb-button${settings.tempMode !== 'none' ? ' active temp' : ''}`}
        title={t('command.tempHideIsolate')}
        onClick={(e) => open(e, tempItems)}
      >
        <Glasses size={15} />
      </button>
      <button
        type="button"
        className={`vcb-button${settings.reveal ? ' active reveal' : ''}`}
        aria-pressed={settings.reveal}
        title={t('command.revealHidden')}
        onClick={toggleReveal}
      >
        <Lightbulb size={15} />
      </button>
      <span className="vcb-separator" />
      <span className="vcb-hint" title={t('vcb.mouseHelp')}>
        {t('vcb.mouseHint')}
      </span>
      {menu ? <ContextMenu x={menu.x} y={Math.max(menu.y, 40)} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
