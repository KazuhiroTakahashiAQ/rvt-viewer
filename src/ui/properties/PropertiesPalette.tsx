import { ChevronDown, ChevronRight, Cuboid, Grid3x3, Box, Table2, View } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../../i18n';
import { viewFullTitle } from '../../model/browserTree';
import { type CategoryKey, categoryRank } from '../../model/categories';
import { familyTypeLabel } from '../../model/naming';
import { formatLength } from '../../model/units';
import { type PropGroup, buildElementProperties, mergeProperties } from '../../model/properties';
import { activeSettings, activeView, useStore } from '../../state/store';
import type { VisualStyle } from '../../engine/modelMaterials';

const VISUAL_STYLES: VisualStyle[] = ['wireframe', 'hiddenLine', 'shaded', 'consistentColors'];

function Group({ group, children }: { group: { id: string; title: string; collapsed?: boolean }; children: ReactNode }) {
  const [open, setOpen] = useState(!group.collapsed);
  return (
    <div className="prop-group">
      <button type="button" className="prop-group-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{group.title}</span>
      </button>
      {open ? <div className="prop-rows">{children}</div> : null}
    </div>
  );
}

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="prop-row">
      <div className="prop-label" title={label}>
        {label}
      </div>
      <div className="prop-value" title={title}>
        {children}
      </div>
    </div>
  );
}

export function PropertiesPalette() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  if (doc && selection.length > 0) return <ElementProperties />;
  return <ViewProperties />;
}

function ElementProperties() {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc)!;
  const selection = useStore((s) => s.selection);
  const unit = useStore((s) => s.prefs.lengthUnit);
  const filter = useStore((s) => s.propertiesFilter);
  const setFilter = useStore((s) => s.setPropertiesFilter);
  const select = useStore((s) => s.select);
  // Bodies change kind as saved meshes are drawn.
  const bodyRevision = useStore((s) => s.bodyRevision);

  const byCategory = useMemo(() => {
    const m = new Map<CategoryKey, number[]>();
    for (const e of selection) {
      const r = doc.index.byIndex.get(e);
      if (!r) continue;
      const list = m.get(r.category);
      if (list) list.push(e);
      else m.set(r.category, [e]);
    }
    return [...m.entries()].sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]));
  }, [doc.index, selection]);

  const shown = filter ? (byCategory.find(([c]) => c === filter)?.[1] ?? selection) : selection;
  const groups: PropGroup[] = useMemo(() => {
    const ctx = { unit, locale: currentLocale(), t };
    const limited = shown.slice(0, 500);
    return mergeProperties(limited.map((e) => buildElementProperties(doc.index, doc.model, e, ctx)));
  }, [doc.index, doc.model, shown, unit, t, bodyRevision]);

  const records = shown.map((e) => doc.index.byIndex.get(e)).filter((r) => !!r);
  const first = records[0];
  const sameType = first && records.every((r) => r.familyName === first.familyName && r.typeName === first.typeName && r.category === first.category);
  const typeLabel = !first
    ? ''
    : sameType
      ? first.category === 'rooms'
        ? t('category.rooms')
        : familyTypeLabel(first.familyName, first.typeName) || t(`category.${first.category}`)
      : t('properties.multipleTypes');

  return (
    <div className="properties">
      <div className="type-selector" title={typeLabel}>
        <div className="type-thumb" aria-hidden="true">
          <Cuboid size={28} />
        </div>
        <div className="type-text">
          <div className="type-family">{sameType && first ? (first.familyName || t(`category.${first.category}`)) : t('properties.multipleFamilies')}</div>
          <div className="type-name">{sameType && first ? first.typeName : ''}</div>
        </div>
      </div>
      <div className="properties-filter">
        <select
          aria-label={t('properties.filterLabel')}
          value={filter ?? ''}
          onChange={(e) => setFilter((e.target.value || null) as CategoryKey | null)}
        >
          {byCategory.length > 1 ? <option value="">{t('properties.common', { count: selection.length })}</option> : null}
          {byCategory.map(([cat, list]) => (
            <option key={cat} value={byCategory.length > 1 ? cat : ''}>
              {t('properties.categoryCount', { category: t(`category.${cat}`), count: list.length })}
            </option>
          ))}
        </select>
        <button type="button" className="button small" disabled title={t('properties.editTypeDisabled')}>
          {t('properties.editType')}
        </button>
      </div>
      <div className="prop-groups">
        {groups.map((g) => (
          <Group key={g.id} group={g}>
            {g.rows.map((r) => (
              <Row key={r.key} label={r.label} title={r.value}>
                {r.links && r.links.length > 0 ? (
                  <span className="prop-links">
                    {r.links.slice(0, 20).map((l) => (
                      <button key={l.entity} type="button" className="link-button" title={l.label} onClick={() => select([l.entity])}>
                        {l.label}
                      </button>
                    ))}
                    {r.links.length > 20 ? <span className="muted">{t('properties.more', { count: r.links.length - 20 })}</span> : null}
                  </span>
                ) : (
                  <span className="prop-text">{r.value}</span>
                )}
              </Row>
            ))}
          </Group>
        ))}
      </div>
    </div>
  );
}

function ViewProperties() {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc);
  const view = useStore(activeView);
  const settings = useStore(activeSettings);
  const update = useStore((s) => s.updateViewSettings);
  const openDialog = useStore((s) => s.openDialog);
  const unit = useStore((s) => s.prefs.lengthUnit);

  if (!doc || !view || !settings) {
    return <div className="palette-empty">{t('properties.nothing')}</div>;
  }
  const isModel = view.kind !== 'schedule';
  const icon =
    view.kind === 'plan' ? <Grid3x3 size={28} /> : view.kind === '3d' ? <Box size={28} /> : view.kind === 'elevation' ? <View size={28} /> : <Table2 size={28} />;
  const storey = view.storeyIndex !== undefined ? doc.index.storeys[view.storeyIndex] : undefined;

  return (
    <div className="properties">
      <div className="type-selector">
        <div className="type-thumb" aria-hidden="true">
          {icon}
        </div>
        <div className="type-text">
          <div className="type-family">{t(`view.kind.${view.kind}`)}</div>
          <div className="type-name">{viewFullTitle(view, doc.index, t)}</div>
        </div>
      </div>
      <div className="prop-groups">
        {isModel ? (
          <Group group={{ id: 'graphics', title: t('propGroup.graphics') }}>
            <Row label={t('viewProp.visualStyle')}>
              <select
                value={settings.visualStyle}
                aria-label={t('viewProp.visualStyle')}
                onChange={(e) => update(view.id, { visualStyle: e.target.value as VisualStyle })}
              >
                {VISUAL_STYLES.map((s) => (
                  <option key={s} value={s}>
                    {t(`visualStyle.${s}`)}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t('viewProp.visibilityGraphics')}>
              <button type="button" className="button small" onClick={() => openDialog('visibilityGraphics')}>
                {t('common.edit')}
              </button>
            </Row>
          </Group>
        ) : null}
        {view.kind === 'plan' ? (
          <Group group={{ id: 'extents', title: t('propGroup.extents') }}>
            <Row label={t('viewProp.associatedLevel')}>{storey?.name ?? ''}</Row>
            <Row label={t('viewProp.cutPlane')}>
              <input
                type="number"
                step={100}
                value={settings.planRange.cutMm}
                aria-label={t('viewProp.cutPlane')}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) update(view.id, { planRange: { ...settings.planRange, cutMm: v } });
                }}
              />
            </Row>
            <Row label={t('viewProp.viewDepth')}>
              <input
                type="number"
                step={100}
                max={0}
                value={settings.planRange.bottomMm}
                aria-label={t('viewProp.viewDepth')}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) update(view.id, { planRange: { ...settings.planRange, bottomMm: Math.min(v, 0) } });
                }}
              />
            </Row>
          </Group>
        ) : null}
        {view.kind === '3d' ? (
          <Group group={{ id: 'extents', title: t('propGroup.extents') }}>
            <Row label={t('viewProp.sectionBox')}>
              <input
                type="checkbox"
                checked={settings.sectionBox.enabled}
                aria-label={t('viewProp.sectionBox')}
                onChange={(e) => update(view.id, { sectionBox: { ...settings.sectionBox, enabled: e.target.checked } })}
              />
            </Row>
            <Row label={t('viewProp.projection')}>
              <select
                value={settings.projection}
                aria-label={t('viewProp.projection')}
                onChange={(e) => update(view.id, { projection: e.target.value as 'ortho' | 'perspective' })}
              >
                <option value="ortho">{t('projection.ortho')}</option>
                <option value="perspective">{t('projection.perspective')}</option>
              </select>
            </Row>
          </Group>
        ) : null}
        <Group group={{ id: 'identity', title: t('propGroup.identity') }}>
          <Row label={t('viewProp.viewName')}>{viewFullTitle(view, doc.index, t)}</Row>
          {storey ? <Row label={t('prop.levelElevation')}>{formatLength(storey.elevationFeet, unit, currentLocale())}</Row> : null}
        </Group>
      </div>
    </div>
  );
}
