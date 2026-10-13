import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type CategoryOverride, UNASSIGNED_LEVEL } from '../../engine/types';
import { currentLocale } from '../../i18n';
import type { CategoryKey } from '../../model/categories';
import { viewFullTitle } from '../../model/browserTree';
import { formatLength } from '../../model/units';
import { activeSettings, activeView, levelKeys, useStore } from '../../state/store';
import { Dialog } from '../common/Dialog';

const DEFAULT_SURFACE = '#c0c4ca';

type Tab = 'categories' | 'levels';

/** 表示/グラフィックスの上書き — model categories and levels. */
export function VisibilityGraphicsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc)!;
  const view = useStore(activeView)!;
  const settings = useStore(activeSettings)!;
  const update = useStore((s) => s.updateViewSettings);

  const [hidden, setHidden] = useState<Set<CategoryKey>>(() => new Set(settings.hiddenCategories));
  const [overrides, setOverrides] = useState<Partial<Record<CategoryKey, CategoryOverride>>>(() => ({ ...settings.overrides }));
  const [hiddenLevels, setHiddenLevels] = useState<Set<number>>(() => new Set(settings.hiddenLevels));
  const [tab, setTab] = useState<Tab>('categories');
  const [filter, setFilter] = useState('');
  const unit = useStore((s) => s.prefs.lengthUnit);
  const categories = useMemo(() => doc.index.categories, [doc]);
  const levels = useMemo(() => {
    const counts = new Map<number, number>();
    for (const e of doc.index.elements) {
      const k = e.storeyIndex ?? UNASSIGNED_LEVEL;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return levelKeys(doc.index)
      .map((key) => ({ key, storey: doc.index.storeys[key], count: counts.get(key) ?? 0 }))
      .sort((a, b) => (a.storey?.elevationFeet ?? -Infinity) - (b.storey?.elevationFeet ?? -Infinity));
  }, [doc]);
  const shown = categories.filter((c) => !filter || t(`category.${c.key}`).includes(filter));

  const setOv = (cat: CategoryKey, patch: Partial<CategoryOverride>) =>
    setOverrides((prev) => {
      const next = { ...(prev[cat] ?? {}), ...patch };
      (Object.keys(next) as (keyof CategoryOverride)[]).forEach((k) => next[k] === undefined && delete next[k]);
      return { ...prev, [cat]: next };
    });

  const apply = () => update(view.id, { hiddenCategories: [...hidden], hiddenLevels: [...hiddenLevels], overrides });
  const toggleLevel = (key: number, visible: boolean) =>
    setHiddenLevels((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Dialog
      title={t('vg.title', { view: viewFullTitle(view, doc.index, t) })}
      onClose={onClose}
      width={720}
      footer={
        <>
          <button type="button" className="button primary" onClick={() => (apply(), onClose())}>
            {t('common.ok')}
          </button>
          <button type="button" className="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="button" onClick={apply}>
            {t('common.apply')}
          </button>
        </>
      }
    >
      <div className="dialog-tabs" role="tablist">
        {(
          [
            ['categories', t('vg.modelCategories')],
            ['levels', t('vg.levels')],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`dialog-tab${tab === id ? ' selected' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'levels' ? (
        <>
          <div className="vg-toolbar">
            <span className="muted">{t('vg.levelsLead')}</span>
            <span className="vg-buttons">
              <button type="button" className="button small" onClick={() => setHiddenLevels(new Set())}>
                {t('vg.all')}
              </button>
              <button type="button" className="button small" onClick={() => setHiddenLevels(new Set(levels.map((l) => l.key)))}>
                {t('vg.none')}
              </button>
              <button
                type="button"
                className="button small"
                onClick={() => setHiddenLevels(new Set(levels.map((l) => l.key).filter((k) => !hiddenLevels.has(k))))}
              >
                {t('vg.invert')}
              </button>
            </span>
          </div>
          <div className="vg-table" role="table">
            <div className="vg-row vg-level-row vg-head" role="row">
              <span role="columnheader">{t('vg.visibility')}</span>
              <span role="columnheader">{t('vg.level')}</span>
              <span role="columnheader" className="numeric">
                {t('vg.elevation', { unit })}
              </span>
              <span role="columnheader" className="numeric">
                {t('vg.elementCount')}
              </span>
            </div>
            {levels.map(({ key, storey, count }) => {
              const name = storey?.name ?? t('value.unassigned');
              return (
                <div key={key} className="vg-row vg-level-row" role="row">
                  <span role="cell">
                    <input
                      type="checkbox"
                      aria-label={t('vg.visibleOf', { category: name })}
                      checked={!hiddenLevels.has(key)}
                      onChange={(e) => toggleLevel(key, e.target.checked)}
                    />
                  </span>
                  <span role="cell" className="vg-cat">
                    {name}
                  </span>
                  <span role="cell" className="numeric">
                    {storey ? formatLength(storey.elevationFeet, unit, currentLocale()) : ''}
                  </span>
                  <span role="cell" className="numeric">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
      <div className="vg-toolbar">
        <label className="vg-filter">
          {t('vg.filter')}
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <span className="vg-buttons">
          <button type="button" className="button small" onClick={() => setHidden(new Set())}>
            {t('vg.all')}
          </button>
          <button type="button" className="button small" onClick={() => setHidden(new Set(categories.map((c) => c.key)))}>
            {t('vg.none')}
          </button>
          <button
            type="button"
            className="button small"
            onClick={() => setHidden(new Set(categories.map((c) => c.key).filter((k) => !hidden.has(k))))}
          >
            {t('vg.invert')}
          </button>
        </span>
      </div>
      <div className="vg-table" role="table">
        <div className="vg-row vg-head" role="row">
          <span role="columnheader">{t('vg.visibility')}</span>
          <span role="columnheader">{t('vg.category')}</span>
          <span role="columnheader">{t('vg.surfaceColor')}</span>
          <span role="columnheader">{t('vg.transparency')}</span>
          <span role="columnheader">{t('vg.halftone')}</span>
        </div>
        {shown.map(({ key, count }) => {
          const ov = overrides[key] ?? {};
          return (
            <div key={key} className="vg-row" role="row">
              <span role="cell">
                <input
                  type="checkbox"
                  aria-label={t('vg.visibleOf', { category: t(`category.${key}`) })}
                  checked={!hidden.has(key)}
                  onChange={(e) =>
                    setHidden((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                />
              </span>
              <span role="cell" className="vg-cat">
                {t(`category.${key}`)} <span className="muted">({count})</span>
              </span>
              <span role="cell" className="vg-color">
                <input
                  type="checkbox"
                  aria-label={t('vg.overrideColor')}
                  checked={!!ov.color}
                  onChange={(e) => setOv(key, { color: e.target.checked ? DEFAULT_SURFACE : undefined })}
                />
                <input
                  type="color"
                  aria-label={t('vg.surfaceColor')}
                  disabled={!ov.color}
                  value={ov.color ?? DEFAULT_SURFACE}
                  onChange={(e) => setOv(key, { color: e.target.value })}
                />
              </span>
              <span role="cell" className="vg-transparency">
                <input
                  type="range"
                  min={0}
                  max={90}
                  step={5}
                  aria-label={t('vg.transparency')}
                  value={ov.transparency ?? 0}
                  onChange={(e) => setOv(key, { transparency: Number(e.target.value) || undefined })}
                />
                <span className="muted">{ov.transparency ?? 0}%</span>
              </span>
              <span role="cell">
                <input
                  type="checkbox"
                  aria-label={t('vg.halftone')}
                  checked={!!ov.halftone}
                  onChange={(e) => setOv(key, { halftone: e.target.checked || undefined })}
                />
              </span>
            </div>
          );
        })}
      </div>
        </>
      )}
      <p className="muted small">{t('vg.note')}</p>
    </Dialog>
  );
}
