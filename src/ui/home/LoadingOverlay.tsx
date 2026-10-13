import { Check, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { closeDocument } from '../../app/document';
import { currentLocale } from '../../i18n';
import { useStore } from '../../state/store';
import type { LoadStep } from '../../worker/protocol';

const STEPS: LoadStep[] = ['init', 'metadata', 'parse', 'scene', 'geometry', 'schedule'];
/** Rough decode throughput, used only for the time estimate. */
const DECODE_BYTES_PER_SECOND = 4e6;

export function LoadingOverlay() {
  const { t } = useTranslation();
  const loading = useStore((s) => s.loading);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  if (!loading) return null;
  const current = STEPS.indexOf(loading.step);
  const elapsed = Math.max(0, (now - loading.startedAt) / 1000);
  const estimate = Math.max(1, loading.fileSize / DECODE_BYTES_PER_SECOND);
  const nf = new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const version = loading.summary?.version;

  return (
    <div className="loading" role="dialog" aria-modal="true" aria-label={t('loading.title')}>
      <div className="loading-card">
        <div className="loading-title">
          <LoaderCircle size={18} className="spin" />
          <span>{t('loading.opening', { name: loading.fileName })}</span>
        </div>
        {version ? <div className="loading-version">{t('loading.version', { version })}</div> : null}
        <ol className="loading-steps">
          {STEPS.map((step, i) => (
            <li key={step} className={i < current ? 'done' : i === current ? 'current' : ''}>
              {i < current ? <Check size={13} /> : i === current ? <LoaderCircle size={13} className="spin" /> : <span className="dot" />}
              {t(`loading.step.${step}`)}
            </li>
          ))}
        </ol>
        <div className="progress" aria-hidden="true">
          <div className="progress-bar" style={{ width: `${Math.min(95, (elapsed / estimate) * 90)}%` }} />
        </div>
        <div className="loading-footer">
          <span className="muted">{t('loading.elapsed', { seconds: nf.format(elapsed) })}</span>
          <button type="button" className="button small" onClick={closeDocument}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
