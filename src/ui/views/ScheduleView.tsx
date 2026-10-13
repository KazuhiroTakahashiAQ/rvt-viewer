import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { exportDocument } from '../../app/document';
import { currentLocale } from '../../i18n';
import { categoryRank } from '../../model/categories';
import { findProperty } from '../../model/modelIndex';
import { formatPropertyValue, materialNames, roomMeasures } from '../../model/properties';
import { formatArea, formatLength, formatVolume } from '../../model/units';
import type { ScheduleKind } from '../../model/views';
import { useStore } from '../../state/store';

const ROW_HEIGHT = 24;

interface Column {
  id: string;
  label: string;
  numeric?: boolean;
  width: number;
}

interface Row {
  entity: number;
  cells: string[];
  sort: (string | number)[];
}

export function ScheduleView({ kind }: { kind: ScheduleKind }) {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc)!;
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const unit = useStore((s) => s.prefs.lengthUnit);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 }>({ col: 0, dir: 1 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const locale = currentLocale();

  const { columns, rows } = useMemo(() => {
    const index = doc.index;
    const levelName = (i: number | null) => (i !== null ? (index.storeys[i]?.name ?? '') : '');
    const levelElev = (i: number | null) => (i !== null ? (index.storeys[i]?.elevationFeet ?? 0) : -Infinity);
    if (kind === 'rooms') {
      const columns: Column[] = [
        { id: 'number', label: t('schedule.col.number'), width: 90 },
        { id: 'name', label: t('schedule.col.name'), width: 200 },
        { id: 'level', label: t('schedule.col.level'), width: 160 },
        { id: 'area', label: t('schedule.col.area'), numeric: true, width: 110 },
        { id: 'perimeter', label: t('schedule.col.perimeter', { unit }), numeric: true, width: 110 },
        { id: 'volume', label: t('schedule.col.volume'), numeric: true, width: 110 },
        { id: 'id', label: t('schedule.col.elementId'), width: 100 },
      ];
      const rows: Row[] = index.elements
        .filter((r) => r.category === 'rooms')
        .map((r) => {
          const m = roomMeasures(r);
          return {
            entity: r.index,
            cells: [
              r.roomNumber ?? '',
              r.roomName ?? '',
              levelName(r.storeyIndex),
              m ? formatArea(m.area, locale) : '',
              m ? formatLength(m.perimeter, unit, locale) : '',
              m ? formatVolume(m.volume, locale) : '',
              r.elementId,
            ],
            sort: [r.roomNumber ?? '', r.roomName ?? '', levelElev(r.storeyIndex), m?.area ?? 0, m?.perimeter ?? 0, m?.volume ?? 0, Number(r.elementId) || 0],
          };
        });
      return { columns, rows };
    }
    const columns: Column[] = [
      { id: 'category', label: t('schedule.col.category'), width: 130 },
      { id: 'family', label: t('schedule.col.family'), width: 170 },
      { id: 'type', label: t('schedule.col.type'), width: 200 },
      { id: 'level', label: t('schedule.col.level'), width: 150 },
      { id: 'mark', label: t('schedule.col.typeMark'), width: 90 },
      { id: 'material', label: t('schedule.col.material'), width: 140 },
      { id: 'id', label: t('schedule.col.elementId'), width: 100 },
    ];
    const ctx = { unit, locale, t };
    const rows: Row[] = index.elements
      .filter((r) => r.category !== 'rooms')
      .map((r) => {
        const mark = formatPropertyValue(findProperty(r.entity.property_set, 'Type Mark'), ctx);
        const material = materialNames(doc.model, r).join(', ');
        const cat = t(`category.${r.category}`);
        return {
          entity: r.index,
          cells: [cat, r.familyName, r.typeName, levelName(r.storeyIndex), mark, material, r.elementId],
          sort: [categoryRank(r.category), r.familyName, r.typeName, levelElev(r.storeyIndex), mark, material, Number(r.elementId) || 0],
        };
      });
    return { columns, rows };
  }, [doc, kind, t, unit, locale]);

  const sorted = useMemo(() => {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    const { col, dir } = sort;
    return [...rows].sort((a, b) => {
      const x = a.sort[col]!;
      const y = b.sort[col]!;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
      return c * dir || a.entity - b.entity;
    });
  }, [rows, sort, locale]);

  const selected = useMemo(() => new Set(selection), [selection]);
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });
  const totalWidth = columns.reduce((s, c) => s + c.width, 0);
  const template = columns.map((c) => `${c.width}px`).join(' ');

  return (
    <div className="schedule">
      <div className="schedule-toolbar">
        <span className="schedule-count">{t('schedule.count', { count: sorted.length })}</span>
        <button type="button" className="button small" onClick={() => void exportDocument(kind === 'rooms' ? 'csv-rooms' : 'csv-elements')}>
          <Download size={13} />
          {t('schedule.exportCsv')}
        </button>
      </div>
      <div ref={scrollRef} className="schedule-scroll" role="grid" aria-rowcount={sorted.length + 2} aria-label={t(`view.schedule.${kind}`)}>
        <div style={{ width: totalWidth, minWidth: '100%' }}>
          <div className="schedule-title" style={{ width: totalWidth }}>{`<${t(`view.schedule.${kind}`)}>`}</div>
          <div className="schedule-header" role="row" style={{ gridTemplateColumns: template, width: totalWidth }}>
            {columns.map((c, i) => (
              <button
                key={c.id}
                type="button"
                role="columnheader"
                className={`schedule-th${c.numeric ? ' numeric' : ''}`}
                aria-sort={sort.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                onClick={() => setSort((s) => ({ col: i, dir: s.col === i ? ((-s.dir) as 1 | -1) : 1 }))}
              >
                <span>{c.label}</span>
                {sort.col === i ? sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : null}
              </button>
            ))}
          </div>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: totalWidth }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = sorted[vi.index]!;
              return (
                <div
                  key={row.entity}
                  role="row"
                  aria-selected={selected.has(row.entity)}
                  className={`schedule-row${selected.has(row.entity) ? ' selected' : ''}`}
                  style={{ transform: `translateY(${vi.start}px)`, gridTemplateColumns: template, height: ROW_HEIGHT }}
                  onClick={(e) => select([row.entity], e.ctrlKey || e.metaKey ? 'add' : e.shiftKey ? 'remove' : 'replace')}
                >
                  {row.cells.map((cell, i) => (
                    <div key={columns[i]!.id} role="gridcell" className={`schedule-td${columns[i]!.numeric ? ' numeric' : ''}`} title={cell}>
                      {cell}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
