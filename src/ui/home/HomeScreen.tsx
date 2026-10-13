import { FileText, FolderOpen, ShieldCheck, TriangleAlert, Upload, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openRecent, pickAndOpen } from '../../app/document';
import { currentLocale } from '../../i18n';
import { listRecentFiles, type RecentFile } from '../../pwa/recentFiles';
import { useStore } from '../../state/store';

function formatSize(bytes: number): string {
  const nf = new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1 });
  if (bytes >= 1024 * 1024) return `${nf.format(bytes / 1024 / 1024)} MB`;
  return `${nf.format(bytes / 1024)} KB`;
}

/** Revit-like home screen shown when no document is open. */
export function HomeScreen() {
  const { t } = useTranslation();
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const loadError = useStore((s) => s.loadError);
  const dismissError = useStore((s) => s.dismissLoadError);

  useEffect(() => {
    void listRecentFiles().then(setRecent);
  }, []);

  const dateFmt = new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="home">
      <nav className="home-nav" aria-label={t('home.navLabel')}>
        <div className="home-nav-title">{t('home.models')}</div>
        <button type="button" className="home-nav-item" onClick={() => void pickAndOpen()}>
          <FolderOpen size={16} />
          {t('command.openEllipsis')}
        </button>
      </nav>
      <section className="home-main">
        <h1 className="home-title">{t('app.name')}</h1>
        <p className="home-lead">{t('home.lead')}</p>

        {loadError ? (
          <div className="load-error" role="alert">
            <TriangleAlert size={18} />
            <div>
              <strong>{t('loadError.title', { name: loadError.fileName })}</strong>
              <p>{t(`loadError.${loadError.code}`)}</p>
              <details>
                <summary>{t('loadError.details')}</summary>
                <code>{loadError.detail}</code>
              </details>
            </div>
            <button type="button" className="icon-button" aria-label={t('common.close')} onClick={dismissError}>
              <X size={14} />
            </button>
          </div>
        ) : null}

        <button type="button" className="dropzone" onClick={() => void pickAndOpen()}>
          <Upload size={28} />
          <span className="dropzone-main">{t('home.dropzone')}</span>
          <span className="dropzone-sub">{t('home.dropzoneSub')}</span>
        </button>

        <h2 className="home-section-title">{t('recent.title')}</h2>
        {recent.length === 0 ? (
          <p className="muted">{t('recent.emptyHome')}</p>
        ) : (
          <div className="recent-grid">
            {recent.map((r) => (
              <button key={`${r.name}-${r.openedAt}`} type="button" className="recent-card" onClick={() => void openRecent(r)}>
                <FileText size={30} />
                <span className="recent-name" title={r.name}>
                  {r.name}
                </span>
                <span className="recent-meta">
                  {formatSize(r.size)} · {dateFmt.format(r.openedAt)}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="home-info">
          <div className="home-info-card">
            <ShieldCheck size={18} />
            <div>
              <strong>{t('home.privacyTitle')}</strong>
              <p>{t('home.privacy')}</p>
            </div>
          </div>
          <div className="home-info-card">
            <WifiOff size={18} />
            <div>
              <strong>{t('home.offlineTitle')}</strong>
              <p>{t('home.offline')}</p>
            </div>
          </div>
          <div className="home-info-card">
            <FileText size={18} />
            <div>
              <strong>{t('home.supportTitle')}</strong>
              <ul>
                <li>{t('home.support2024')}</li>
                <li>{t('home.support2023')}</li>
                <li>{t('home.supportOther')}</li>
                <li>{t('home.supportFamily')}</li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
