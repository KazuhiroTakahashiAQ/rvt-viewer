import { useVirtualizer } from '@tanstack/react-virtual';
import { Box, Building, ChevronDown, ChevronRight, Grid3x3, Search, Table2, View } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { selectElements } from '../../app/commands';
import { type BrowserNode, buildBrowserTree, flattenTree } from '../../model/browserTree';
import { useStore } from '../../state/store';
import { ContextMenu, type MenuItem } from '../common/Menu';

const ROW_HEIGHT = 22;

function nodeIcon(node: BrowserNode, viewKind: string | undefined) {
  if (node.kind !== 'view') return null;
  switch (viewKind) {
    case 'plan':
      return <Grid3x3 size={13} />;
    case '3d':
      return <Box size={13} />;
    case 'elevation':
      return <View size={13} />;
    case 'schedule':
      return <Table2 size={13} />;
    default:
      return <Building size={13} />;
  }
}

export function ProjectBrowser() {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc);
  const views = useStore((s) => s.views);
  const activeViewId = useStore((s) => s.activeViewId);
  const openView = useStore((s) => s.openView);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['g:views', 'g:plans', 'g:3d', 'g:elev', 'g:schedules']));
  const [filter, setFilter] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => (doc ? buildBrowserTree(views, doc.index, t) : []), [doc, views, t]);
  const rows = useMemo(() => flattenTree(tree, expanded, filter), [tree, expanded, filter]);
  const viewKind = useMemo(() => new Map(views.map((v) => [v.id, v.kind])), [views]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (!doc) return <div className="palette-empty">{t('browser.noDocument')}</div>;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const activate = (node: BrowserNode) => {
    if (node.viewId) openView(node.viewId);
    else if (node.children?.length) toggle(node.id);
  };

  const onContextMenu = (ev: React.MouseEvent, node: BrowserNode) => {
    ev.preventDefault();
    setFocusId(node.id);
    const items: MenuItem[] = [];
    if (node.viewId) items.push({ id: 'open', label: t('command.openView'), onSelect: () => openView(node.viewId!) });
    if (node.elements?.length) {
      items.push({
        id: 'selectAll',
        label: t('command.selectAllInstances'),
        submenu: [
          { id: 'view', label: t('command.visibleInView'), onSelect: () => selectElements(node.elements!, 'view') },
          { id: 'project', label: t('command.inEntireProject'), onSelect: () => selectElements(node.elements!, 'project') },
        ],
      });
    }
    if (node.children?.length) {
      items.push({ id: 'expand', label: expanded.has(node.id) ? t('command.collapse') : t('command.expand'), onSelect: () => toggle(node.id) });
    }
    if (items.length) setMenu({ x: ev.clientX, y: ev.clientY, items });
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.node.id === focusId);
    const row = rows[i];
    let next = i;
    switch (ev.key) {
      case 'ArrowDown':
        next = Math.min(rows.length - 1, i + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, i - 1);
        break;
      case 'ArrowRight':
        if (row?.hasChildren && !row.expanded) toggle(row.node.id);
        break;
      case 'ArrowLeft':
        if (row?.hasChildren && row.expanded) toggle(row.node.id);
        break;
      case 'Enter':
        if (row) activate(row.node);
        break;
      default:
        return;
    }
    ev.preventDefault();
    const target = rows[next];
    if (target) {
      setFocusId(target.node.id);
      virtualizer.scrollToIndex(next);
    }
  };

  return (
    <div className="browser">
      <div className="browser-search">
        <Search size={13} />
        <input
          type="search"
          value={filter}
          placeholder={t('browser.search')}
          aria-label={t('browser.search')}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div
        ref={scrollRef}
        className="browser-tree"
        role="tree"
        aria-label={t('ui.projectBrowserTitle')}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index]!;
            const node = row.node;
            const isActive = node.viewId === activeViewId;
            const count = node.kind === 'type' ? node.elements?.length : undefined;
            return (
              <div
                key={node.id}
                role="treeitem"
                aria-expanded={row.hasChildren ? row.expanded : undefined}
                aria-selected={focusId === node.id}
                aria-level={row.depth + 1}
                className={`tree-row${focusId === node.id ? ' focused' : ''}${isActive ? ' active' : ''} kind-${node.kind}`}
                style={{ transform: `translateY(${vi.start}px)`, height: ROW_HEIGHT, paddingLeft: 4 + row.depth * 14 }}
                onClick={() => setFocusId(node.id)}
                onDoubleClick={() => activate(node)}
                onContextMenu={(e) => onContextMenu(e, node)}
                title={node.label}
              >
                <span
                  className="tree-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (row.hasChildren) toggle(node.id);
                  }}
                >
                  {row.hasChildren ? row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
                </span>
                {nodeIcon(node, node.viewId ? viewKind.get(node.viewId) : undefined)}
                <span className="tree-label">{node.label}</span>
                {count !== undefined && count > 1 ? <span className="tree-count">{count}</span> : null}
              </div>
            );
          })}
        </div>
      </div>
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
