import { Download } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { exportDocument } from '../../app/document';
import { SUPPORTED_LANGUAGES, currentLocale } from '../../i18n';
import { type CategoryKey, categoryRank } from '../../model/categories';
import { formatLength, type LengthUnit } from '../../model/units';
import { type BackgroundPref, type ThemePref, useStore } from '../../state/store';
import { Dialog } from '../common/Dialog';
import { VisibilityGraphicsDialog } from './VisibilityGraphicsDialog';

function InfoTable({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <table className="info-table">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td>{v === undefined || v === null || v === '' ? <span className="muted">—</span> : v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OkFooter({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="button primary" onClick={onClose}>
      {t('common.ok')}
    </button>
  );
}

function SelectionFilterDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc)!;
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const groups = useMemo(() => {
    const m = new Map<CategoryKey, number[]>();
    for (const e of selection) {
      const r = doc.index.byIndex.get(e);
      if (!r) continue;
      const l = m.get(r.category);
      if (l) l.push(e);
      else m.set(r.category, [e]);
    }
    return [...m.entries()].sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]));
  }, [doc, selection]);
  const [checked, setChecked] = useState<Set<CategoryKey>>(() => new Set(groups.map(([c]) => c)));
  const total = groups.filter(([c]) => checked.has(c)).reduce((s, [, l]) => s + l.length, 0);

  return (
    <Dialog
      title={t('filter.title')}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              select(groups.filter(([c]) => checked.has(c)).flatMap(([, l]) => l), 'replace');
              onClose();
            }}
          >
            {t('common.ok')}
          </button>
          <button type="button" className="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </>
      }
    >
      <div className="filter-layout">
        <div className="filter-list" role="group" aria-label={t('filter.category')}>
          <div className="filter-head">
            <span>{t('filter.category')}</span>
            <span>{t('filter.count')}</span>
          </div>
          {groups.map(([cat, list]) => (
            <label key={cat} className="filter-row">
              <input
                type="checkbox"
                checked={checked.has(cat)}
                onChange={(e) =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(cat);
                    else next.delete(cat);
                    return next;
                  })
                }
              />
              <span>{t(`category.${cat}`)}</span>
              <span className="filter-count">{list.length}</span>
            </label>
          ))}
        </div>
        <div className="filter-side">
          <button type="button" className="button" onClick={() => setChecked(new Set(groups.map(([c]) => c)))}>
            {t('filter.checkAll')}
          </button>
          <button type="button" className="button" onClick={() => setChecked(new Set())}>
            {t('filter.checkNone')}
          </button>
        </div>
      </div>
      <p className="filter-total">{t('filter.total', { count: total })}</p>
    </Dialog>
  );
}

function ProjectInfoDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc)!;
  const unit = useStore((s) => s.prefs.lengthUnit);
  const locale = currentLocale();
  const title = doc.metadata?.title ?? doc.summary?.partatom?.title ?? doc.model.project_name ?? doc.fileName;
  const storeys = [...doc.index.storeys].sort((a, b) => a.elevationFeet - b.elevationFeet);
  return (
    <Dialog title={t('projectInfo.title')} onClose={onClose} width={560} footer={<OkFooter onClose={onClose} />}>
      <InfoTable
        rows={[
          [t('projectInfo.name'), title],
          [t('projectInfo.fileName'), doc.fileName],
          [t('projectInfo.revitVersion'), String(doc.summary?.version ?? doc.metadata?.revit_version ?? '')],
          [t('projectInfo.elements'), String(doc.index.elements.length)],
          [t('projectInfo.materials'), String(doc.model.materials.length)],
          [t('projectInfo.description'), doc.model.description ?? ''],
        ]}
      />
      <h3 className="dialog-subtitle">{t('projectInfo.levels')}</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('projectInfo.levelName')}</th>
            <th className="numeric">{t('projectInfo.elevation', { unit })}</th>
          </tr>
        </thead>
        <tbody>
          {storeys.map((s) => (
            <tr key={s.index}>
              <td>{s.name}</td>
              <td className="numeric">{formatLength(s.elevationFeet, unit, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="dialog-subtitle">{t('projectInfo.categories')}</h3>
      <table className="data-table">
        <tbody>
          {doc.index.categories.map((c) => (
            <tr key={c.key}>
              <td>{t(`category.${c.key}`)}</td>
              <td className="numeric">{c.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

function FileInfoDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc)!;
  const m = doc.metadata;
  const s = doc.summary;
  const dateFmt = new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'long', timeStyle: 'medium' });
  const saved = m?.last_saved ? dateFmt.format(new Date(m.last_saved)) : '';
  const sizeFmt = new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1 });
  return (
    <Dialog title={t('fileInfo.title')} onClose={onClose} width={620} footer={<OkFooter onClose={onClose} />}>
      <InfoTable
        rows={[
          [t('fileInfo.fileName'), doc.fileName],
          [t('fileInfo.fileSize'), `${sizeFmt.format(doc.fileSize / 1024 / 1024)} MB`],
          [t('fileInfo.revitVersion'), String(m?.revit_version ?? s?.version ?? '')],
          [t('fileInfo.build'), m?.build ?? s?.build ?? ''],
          [t('fileInfo.lastSaved'), saved],
          [t('fileInfo.username'), m?.username ?? ''],
          [t('fileInfo.worksharing'), m?.worksharing ?? ''],
          [t('fileInfo.centralPath'), m?.central_model_path ?? ''],
          [t('fileInfo.lastSavePath'), m?.last_save_path ?? s?.original_path ?? ''],
          [t('fileInfo.documentGuid'), m?.document_guid ?? s?.guid ?? ''],
          [t('fileInfo.increments'), m?.document_increments !== undefined ? String(m.document_increments) : ''],
          [t('fileInfo.locale'), m?.locale ?? s?.locale ?? ''],
          [t('fileInfo.streams'), s ? String(s.streams.length) : ''],
        ]}
      />
      {m?.properties.length ? (
        <details className="dialog-details">
          <summary>{t('fileInfo.basicFileInfo')}</summary>
          <InfoTable rows={m.properties.map((p) => [p.key, p.value] as [string, ReactNode])} />
        </details>
      ) : null}
    </Dialog>
  );
}

function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const doc = useStore((s) => s.doc)!;
  const d = doc.diagnostics;
  const pct = new Intl.NumberFormat(currentLocale(), { style: 'percent', maximumFractionDigits: 0 });
  return (
    <Dialog
      title={t('diagnostics.title')}
      onClose={onClose}
      width={600}
      footer={
        <>
          <button type="button" className="button" onClick={() => void exportDocument('diagnostics')}>
            <Download size={13} />
            {t('diagnostics.download')}
          </button>
          <OkFooter onClose={onClose} />
        </>
      }
    >
      <p className="muted">{t('diagnostics.lead')}</p>
      <InfoTable
        rows={[
          [t('diagnostics.level'), t(`confidence.${d.confidence.level}`)],
          [t('diagnostics.score'), pct.format(d.confidence.score)],
          [t('diagnostics.elements'), String(d.exported.building_elements)],
          [t('diagnostics.withGeometry'), String(d.exported.building_elements_with_geometry)],
          [t('diagnostics.bboxBodies'), String(d.exported.bounding_box_bodies)],
          [t('diagnostics.storeys'), String(d.exported.storey_count)],
          [t('diagnostics.materials'), String(d.exported.material_count)],
          [t('diagnostics.parameters'), String(d.decoded.parameter_value_count)],
        ]}
      />
      {d.warnings.length ? (
        <>
          <h3 className="dialog-subtitle">{t('diagnostics.warnings', { count: d.warnings.length })}</h3>
          <ul className="diag-list">
            {d.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      ) : null}
      {d.unsupported_features.length ? (
        <>
          <h3 className="dialog-subtitle">{t('diagnostics.unsupported')}</h3>
          <ul className="diag-list">
            {d.unsupported_features.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      ) : null}
    </Dialog>
  );
}

function UnitsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const [unit, setUnit] = useState<LengthUnit>(prefs.lengthUnit);
  return (
    <Dialog
      title={t('units.title')}
      onClose={onClose}
      width={380}
      footer={
        <>
          <button type="button" className="button primary" onClick={() => (setPrefs({ lengthUnit: unit }), onClose())}>
            {t('common.ok')}
          </button>
          <button type="button" className="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </>
      }
    >
      <fieldset className="field">
        <legend>{t('units.length')}</legend>
        {(['mm', 'm'] as LengthUnit[]).map((u) => (
          <label key={u} className="radio">
            <input type="radio" name="unit" checked={unit === u} onChange={() => setUnit(u)} />
            {t(`units.${u}`)}
          </label>
        ))}
      </fieldset>
      <p className="muted small">{t('units.note')}</p>
    </Dialog>
  );
}

function OptionsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const [theme, setTheme] = useState<ThemePref>(prefs.theme);
  const [background, setBackground] = useState<BackgroundPref>(prefs.background);
  return (
    <Dialog
      title={t('options.title')}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button type="button" className="button primary" onClick={() => (setPrefs({ theme, background }), onClose())}>
            {t('common.ok')}
          </button>
          <button type="button" className="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </>
      }
    >
      <label className="field-row">
        <span>{t('options.language')}</span>
        <select value={currentLocale()} disabled={SUPPORTED_LANGUAGES.length < 2} aria-label={t('options.language')} onChange={() => {}}>
          {SUPPORTED_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {t(`language.${l}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>{t('options.theme')}</span>
        <select value={theme} onChange={(e) => setTheme(e.target.value as ThemePref)}>
          {(['light', 'dark', 'system'] as ThemePref[]).map((v) => (
            <option key={v} value={v}>
              {t(`options.themes.${v}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>{t('options.background')}</span>
        <select value={background} onChange={(e) => setBackground(e.target.value as BackgroundPref)}>
          {(['white', 'gray', 'black'] as BackgroundPref[]).map((v) => (
            <option key={v} value={v}>
              {t(`options.backgrounds.${v}`)}
            </option>
          ))}
        </select>
      </label>
    </Dialog>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog title={t('about.title')} onClose={onClose} width={520} footer={<OkFooter onClose={onClose} />}>
      <h2 className="about-name">{t('app.name')}</h2>
      <p className="muted">{t('about.version', { version: __APP_VERSION__ })}</p>
      <p>{t('about.description')}</p>
      <p>{t('about.privacy')}</p>
      <p>
        {t('about.poweredBy')}{' '}
        <a href="https://github.com/DrunkOnJava/rvt-rs" target="_blank" rel="noreferrer noopener">
          rvt-rs
        </a>{' '}
        ({t('about.rvtLicense')})
      </p>
      <p className="about-links">
        <a href="https://github.com/KazuhiroTakahashiAQ/rvt-viewer" target="_blank" rel="noreferrer noopener">
          {t('about.source')}
        </a>
        <a href={`${import.meta.env.BASE_URL}NOTICE.txt`} target="_blank" rel="noreferrer noopener">
          {t('about.notices')}
        </a>
        <a href={`${import.meta.env.BASE_URL}LICENSE.txt`} target="_blank" rel="noreferrer noopener">
          {t('about.license')}
        </a>
      </p>
      <p className="muted small">{t('about.trademark')}</p>
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const activeViewId = useStore((s) => s.activeViewId);
  const openDialog = useStore((s) => s.openDialog);
  const close = () => openDialog(null);
  switch (dialog) {
    case 'visibilityGraphics':
      return doc && activeViewId ? <VisibilityGraphicsDialog key={activeViewId} onClose={close} /> : null;
    case 'selectionFilter':
      return doc && selection.length ? <SelectionFilterDialog onClose={close} /> : null;
    case 'projectInfo':
      return doc ? <ProjectInfoDialog onClose={close} /> : null;
    case 'fileInfo':
      return doc ? <FileInfoDialog onClose={close} /> : null;
    case 'diagnostics':
      return doc ? <DiagnosticsDialog onClose={close} /> : null;
    case 'units':
      return <UnitsDialog onClose={close} />;
    case 'options':
      return <OptionsDialog onClose={close} />;
    case 'about':
      return <AboutDialog onClose={close} />;
    default:
      return null;
  }
}
