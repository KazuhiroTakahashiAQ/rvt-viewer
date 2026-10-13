import {
  AppWindow,
  Box,
  ChevronDown,
  ChevronUp,
  Cuboid,
  Eye,
  EyeOff,
  FileSearch,
  Activity,
  Funnel,
  Glasses,
  Info,
  Layers,
  Lightbulb,
  Ruler,
  Scan,
  SlidersHorizontal,
  SquareStack,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyTempToView, openDefault3D, selectionBox, toggleSectionBox, zoomSelection } from '../../app/commands';
import { type Prefs, type RibbonTab, activeSettings, activeView, selectionCategories, useStore } from '../../state/store';
import { ContextMenu, type MenuItem } from '../common/Menu';
import { AppMenu } from './AppMenu';

interface RibbonButtonProps {
  icon: ReactNode;
  label: string;
  size?: 'large' | 'small';
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  menu?: MenuItem[];
  title?: string;
}

function RibbonButton({ icon, label, size = 'large', active, disabled, onClick, menu, title }: RibbonButtonProps) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        className={`ribbon-button ${size}${active ? ' active' : ''}`}
        disabled={disabled}
        aria-pressed={active === undefined ? undefined : active}
        aria-haspopup={menu ? 'menu' : undefined}
        title={title ?? label}
        onClick={(e) => {
          if (menu) {
            const r = e.currentTarget.getBoundingClientRect();
            setMenuAt({ x: r.left, y: r.bottom + 2 });
          } else {
            onClick?.();
          }
        }}
      >
        <span className="ribbon-icon">{icon}</span>
        <span className="ribbon-label">
          {label}
          {menu ? <ChevronDown size={11} className="ribbon-caret" /> : null}
        </span>
      </button>
      {menu && menuAt ? <ContextMenu x={menuAt.x} y={menuAt.y} items={menu} onClose={() => setMenuAt(null)} /> : null}
    </>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ribbon-panel" role="group" aria-label={title}>
      <div className="ribbon-panel-content">{children}</div>
      <div className="ribbon-panel-title">{title}</div>
    </div>
  );
}

export function Ribbon() {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc);
  const tab = useStore((s) => s.ribbonTab);
  const setTab = useStore((s) => s.setRibbonTab);
  const selection = useStore((s) => s.selection);
  const view = useStore(activeView);
  const settings = useStore(activeSettings);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const openDialog = useStore((s) => s.openDialog);
  const appMenuOpen = useStore((s) => s.appMenuOpen);
  const setAppMenuOpen = useStore((s) => s.setAppMenuOpen);
  const toggleReveal = useStore((s) => s.toggleReveal);
  const closeInactive = useStore((s) => s.closeInactiveViews);
  const hideInView = useStore((s) => s.hideInView);
  const tempHideIsolate = useStore((s) => s.tempHideIsolate);
  const resetTemp = useStore((s) => s.resetTemp);

  const isModelView = !!view && view.kind !== 'schedule';
  const hasSelection = selection.length > 0 && !!doc;
  const cats = doc && hasSelection ? selectionCategories(doc.index, selection) : [];
  const modifyLabel =
    cats.length === 1 ? t('ribbon.tab.modifyCategory', { category: t(`category.${cats[0]}`) }) : t('ribbon.tab.modifyMultiple');
  const currentTab: RibbonTab = tab === 'modify' && !hasSelection ? 'view' : tab;

  const uiToggle = (key: keyof Prefs, label: string): MenuItem => ({
    id: key,
    label,
    checked: prefs[key] as boolean,
    onSelect: () => setPrefs({ [key]: !prefs[key] } as Partial<Prefs>),
  });

  const tempMenu: MenuItem[] = [
    { id: 'isoCat', label: t('command.isolateCategory'), disabled: !hasSelection, onSelect: () => tempHideIsolate('isolate', 'category') },
    { id: 'hideCat', label: t('command.hideCategory'), disabled: !hasSelection, onSelect: () => tempHideIsolate('hide', 'category') },
    { id: 'isoEl', label: t('command.isolateElements'), disabled: !hasSelection, onSelect: () => tempHideIsolate('isolate', 'elements') },
    { id: 'hideEl', label: t('command.hideElements'), disabled: !hasSelection, onSelect: () => tempHideIsolate('hide', 'elements') },
    { id: 'sep', separator: true },
    { id: 'reset', label: t('command.resetTemp'), disabled: settings?.tempMode === 'none', onSelect: resetTemp },
    { id: 'apply', label: t('command.applyTempToView'), disabled: settings?.tempMode === 'none', onSelect: applyTempToView },
  ];

  return (
    <div className={`ribbon${prefs.ribbonMinimized ? ' minimized' : ''}`}>
      <div className="ribbon-tabs" role="tablist">
        <button
          type="button"
          className={`ribbon-file-tab${appMenuOpen ? ' open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={appMenuOpen}
          onClick={() => setAppMenuOpen(!appMenuOpen)}
        >
          {t('ribbon.tab.file')}
        </button>
        {(
          [
            ['view', t('ribbon.tab.view')],
            ['manage', t('ribbon.tab.manage')],
          ] as [RibbonTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={currentTab === id}
            className={`ribbon-tab${currentTab === id ? ' selected' : ''}`}
            onClick={() => {
              setTab(id);
              if (prefs.ribbonMinimized) setPrefs({ ribbonMinimized: false });
            }}
          >
            {label}
          </button>
        ))}
        {hasSelection ? (
          <button
            type="button"
            role="tab"
            aria-selected={currentTab === 'modify'}
            className={`ribbon-tab contextual${currentTab === 'modify' ? ' selected' : ''}`}
            onClick={() => setTab('modify')}
          >
            {modifyLabel}
          </button>
        ) : null}
        <button
          type="button"
          className="ribbon-minimize"
          title={prefs.ribbonMinimized ? t('ribbon.expand') : t('ribbon.minimize')}
          onClick={() => setPrefs({ ribbonMinimized: !prefs.ribbonMinimized })}
        >
          {prefs.ribbonMinimized ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      {appMenuOpen ? <AppMenu onClose={() => setAppMenuOpen(false)} /> : null}
      {prefs.ribbonMinimized ? null : (
        <div className="ribbon-body" role="tabpanel">
          {currentTab === 'view' ? (
            <>
              <Panel title={t('ribbon.panel.graphics')}>
                <RibbonButton
                  icon={<Layers size={26} />}
                  label={t('command.visibilityGraphics')}
                  disabled={!isModelView}
                  onClick={() => openDialog('visibilityGraphics')}
                />
                <RibbonButton
                  icon={<Lightbulb size={26} />}
                  label={t('command.revealHidden')}
                  disabled={!isModelView}
                  active={!!settings?.reveal}
                  onClick={toggleReveal}
                />
              </Panel>
              <Panel title={t('ribbon.panel.create')}>
                <RibbonButton icon={<Box size={26} />} label={t('command.default3D')} disabled={!doc} onClick={openDefault3D} />
                <RibbonButton
                  icon={<Cuboid size={26} />}
                  label={t('command.sectionBox')}
                  disabled={view?.kind !== '3d'}
                  active={view?.kind === '3d' ? !!settings?.sectionBox.enabled : undefined}
                  onClick={toggleSectionBox}
                />
              </Panel>
              <Panel title={t('ribbon.panel.windows')}>
                <RibbonButton icon={<SquareStack size={26} />} label={t('command.closeInactive')} disabled={!doc} onClick={closeInactive} />
                <RibbonButton
                  icon={<AppWindow size={26} />}
                  label={t('command.userInterface')}
                  menu={[
                    uiToggle('showBrowser', t('ui.projectBrowser')),
                    uiToggle('showProperties', t('ui.properties')),
                    uiToggle('showStatusBar', t('ui.statusBar')),
                    uiToggle('showNavBar', t('ui.navigationBar')),
                    uiToggle('showViewCube', t('ui.viewCube')),
                  ]}
                />
              </Panel>
            </>
          ) : null}
          {currentTab === 'manage' ? (
            <>
              <Panel title={t('ribbon.panel.settings')}>
                <RibbonButton icon={<Info size={26} />} label={t('command.projectInfo')} disabled={!doc} onClick={() => openDialog('projectInfo')} />
                <RibbonButton icon={<Ruler size={26} />} label={t('command.projectUnits')} onClick={() => openDialog('units')} />
              </Panel>
              <Panel title={t('ribbon.panel.inquiry')}>
                <RibbonButton icon={<FileSearch size={26} />} label={t('command.fileInfo')} disabled={!doc} onClick={() => openDialog('fileInfo')} />
                <RibbonButton icon={<Activity size={26} />} label={t('command.diagnostics')} disabled={!doc} onClick={() => openDialog('diagnostics')} />
              </Panel>
              <Panel title={t('ribbon.panel.options')}>
                <RibbonButton icon={<SlidersHorizontal size={26} />} label={t('command.options')} onClick={() => openDialog('options')} />
              </Panel>
            </>
          ) : null}
          {currentTab === 'modify' ? (
            <>
              <Panel title={t('ribbon.panel.selection')}>
                <RibbonButton icon={<Funnel size={26} />} label={t('command.filter')} onClick={() => openDialog('selectionFilter')} />
              </Panel>
              <Panel title={t('ribbon.panel.properties')}>
                <RibbonButton
                  icon={<SlidersHorizontal size={26} />}
                  label={t('ui.properties')}
                  active={prefs.showProperties}
                  onClick={() => setPrefs({ showProperties: !prefs.showProperties })}
                />
              </Panel>
              <Panel title={t('ribbon.panel.view')}>
                <RibbonButton icon={<Glasses size={26} />} label={t('ribbon.tempHideIsolate')} title={t('command.tempHideIsolate')} disabled={!isModelView} menu={tempMenu} />
                <RibbonButton
                  icon={<EyeOff size={26} />}
                  label={t('command.hideInView')}
                  disabled={!isModelView}
                  menu={[
                    { id: 'el', label: t('command.hideElementsInView'), onSelect: () => hideInView('elements') },
                    { id: 'cat', label: t('command.hideCategoryInView'), onSelect: () => hideInView('category') },
                  ]}
                />
                <RibbonButton icon={<Cuboid size={26} />} label={t('command.selectionBox')} disabled={!doc?.hasGeometry} onClick={selectionBox} />
                <RibbonButton icon={<Scan size={26} />} label={t('command.zoomSelection')} disabled={!isModelView} onClick={zoomSelection} />
                {settings?.reveal ? (
                  <RibbonButton
                    icon={<Eye size={26} />}
                    label={t('command.unhide')}
                    menu={[
                      { id: 'el', label: t('command.unhideElements'), onSelect: () => useStore.getState().unhideInView('elements') },
                      { id: 'cat', label: t('command.unhideCategory'), onSelect: () => useStore.getState().unhideInView('category') },
                    ]}
                  />
                ) : null}
              </Panel>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
