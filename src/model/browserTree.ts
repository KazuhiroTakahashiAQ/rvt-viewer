/*
 * Project Browser tree: ビュー (すべて) / 集計表/数量 / ファミリ.
 */

import type { Translate } from './properties';
import { type CategoryKey, categoryRank } from './categories';
import type { ModelIndex } from './modelIndex';
import type { ViewDef } from './views';

export interface BrowserNode {
  id: string;
  label: string;
  kind: 'group' | 'view' | 'category' | 'family' | 'type';
  viewId?: string;
  /** Element entity indices under a category/family/type node. */
  elements?: number[];
  children?: BrowserNode[];
}

export function viewTitle(view: ViewDef, index: ModelIndex, t: Translate): string {
  switch (view.kind) {
    case 'plan':
      return index.storeys[view.storeyIndex ?? 0]?.name ?? t('view.plan');
    case '3d':
      return '{3D}';
    case 'elevation':
      return t(`view.direction.${view.direction ?? 'south'}`);
    case 'schedule':
      return t(`view.schedule.${view.schedule ?? 'elements'}`);
  }
}

/** Tab / title bar label: `平面図: Level 1`. */
export function viewFullTitle(view: ViewDef, index: ModelIndex, t: Translate): string {
  return t(`view.kindPrefix.${view.kind}`, { name: viewTitle(view, index, t) });
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function buildBrowserTree(views: ViewDef[], index: ModelIndex, t: Translate): BrowserNode[] {
  const viewNode = (v: ViewDef): BrowserNode => ({ id: `v:${v.id}`, label: viewTitle(v, index, t), kind: 'view', viewId: v.id });
  const plans = views.filter((v) => v.kind === 'plan');
  const threeD = views.filter((v) => v.kind === '3d');
  const elevations = views.filter((v) => v.kind === 'elevation');
  const schedules = views.filter((v) => v.kind === 'schedule');

  const viewGroups: BrowserNode[] = [];
  if (plans.length) viewGroups.push({ id: 'g:plans', label: t('browser.floorPlans'), kind: 'group', children: plans.map(viewNode) });
  if (threeD.length) viewGroups.push({ id: 'g:3d', label: t('browser.threeDViews'), kind: 'group', children: threeD.map(viewNode) });
  if (elevations.length) {
    viewGroups.push({
      id: 'g:elev',
      label: t('browser.elevations'),
      kind: 'group',
      children: [...elevations].sort((a, b) => collator.compare(viewTitle(a, index, t), viewTitle(b, index, t))).map(viewNode),
    });
  }

  const roots: BrowserNode[] = [{ id: 'g:views', label: t('browser.views'), kind: 'group', children: viewGroups }];
  if (schedules.length) {
    roots.push({ id: 'g:schedules', label: t('browser.schedules'), kind: 'group', children: schedules.map(viewNode) });
  }

  // ファミリ: カテゴリ → ファミリ → タイプ
  const byCat = new Map<CategoryKey, Map<string, Map<string, number[]>>>();
  for (const rec of index.elements) {
    if (rec.category === 'rooms') continue;
    const fam = rec.familyName || t('browser.unnamedFamily');
    const typ = rec.typeName || t('browser.unnamedType');
    let fams = byCat.get(rec.category);
    if (!fams) byCat.set(rec.category, (fams = new Map()));
    let types = fams.get(fam);
    if (!types) fams.set(fam, (types = new Map()));
    const list = types.get(typ);
    if (list) list.push(rec.index);
    else types.set(typ, [rec.index]);
  }
  const catNodes: BrowserNode[] = [...byCat.entries()]
    .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]))
    .map(([cat, fams]) => {
      const famNodes = [...fams.entries()]
        .sort((a, b) => collator.compare(a[0], b[0]))
        .map(([fam, types]) => {
          const typeNodes: BrowserNode[] = [...types.entries()]
            .sort((a, b) => collator.compare(a[0], b[0]))
            .map(([typ, els]) => ({ id: `t:${cat}:${fam}:${typ}`, label: typ, kind: 'type', elements: els }));
          return {
            id: `f:${cat}:${fam}`,
            label: fam,
            kind: 'family' as const,
            elements: typeNodes.flatMap((n) => n.elements ?? []),
            children: typeNodes,
          };
        });
      return {
        id: `c:${cat}`,
        label: t(`category.${cat}`),
        kind: 'category' as const,
        elements: famNodes.flatMap((n) => n.elements ?? []),
        children: famNodes,
      };
    });
  if (catNodes.length) roots.push({ id: 'g:families', label: t('browser.families'), kind: 'group', children: catNodes });
  return roots;
}

export interface FlatRow {
  node: BrowserNode;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
}

/** Visible rows of the tree for virtualised rendering. */
export function flattenTree(nodes: BrowserNode[], expanded: ReadonlySet<string>, filter: string): FlatRow[] {
  const rows: FlatRow[] = [];
  const q = filter.trim().toLowerCase();
  const selfMatch = (n: BrowserNode) => n.label.toLowerCase().includes(q);
  const matches = (n: BrowserNode): boolean => !q || selfMatch(n) || (n.children ?? []).some(matches);
  // While filtering, a matching node shows its whole subtree (collapsed
  // below it unless expanded), and its ancestors are opened.
  const walk = (list: BrowserNode[], depth: number, inMatch: boolean) => {
    for (const n of list) {
      if (!inMatch && !matches(n)) continue;
      const hasChildren = !!n.children?.length;
      const hit = !!q && selfMatch(n);
      const isOpen = hasChildren && (q && !inMatch && !hit ? true : expanded.has(n.id));
      rows.push({ node: n, depth, expanded: isOpen, hasChildren });
      if (isOpen) walk(n.children!, depth + 1, inMatch || hit);
    }
  };
  walk(nodes, 0, false);
  return rows;
}
