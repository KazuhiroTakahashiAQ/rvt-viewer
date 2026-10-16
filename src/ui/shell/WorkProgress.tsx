import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { type WorkProgress, useStore } from '../../state/store';

/**
 * Share done of the whole saved-mesh pass (materials, then the elements
 * drawn) or of the first build, 0..1.
 */
export function workFraction(work: WorkProgress): number {
  const part = work.total > 0 ? Math.min(1, work.done / work.total) : 0;
  switch (work.stage) {
    case 'build-initial':
      return part;
    case 'materials':
      return 0.02 * part;
    case 'meshes':
      return 0.02 + 0.98 * part;
  }
}

/** One formatter for the counts, not one a call (`toLocaleString`). */
const counts = new Intl.NumberFormat();

/** The label of a work stage, with its counts where it has them. */
export function useWorkLabel(work: WorkProgress | null): string {
  const { t } = useTranslation();
  const stage = work?.stage;
  const done = work?.done ?? 0;
  const total = work?.total ?? 0;
  return useMemo(
    () => (stage ? t(`work.${stage}`, { done: counts.format(done), total: counts.format(total) }) : ''),
    [t, stage, done, total],
  );
}

/** A progress bar for the current work, or nothing. */
export function WorkProgressBar({ className }: { className?: string }) {
  const work = useStore((s) => s.work);
  const label = useWorkLabel(work);
  if (!work) return null;
  const percent = Math.round(workFraction(work) * 100);
  // One wasm call, with no count to report: animate instead.
  const indeterminate = work.stage === 'materials' && work.done === 0;
  return (
    <div
      className={`work-progress${className ? ` ${className}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-stage={work.stage}
      data-indeterminate={indeterminate || undefined}
      title={label}
    >
      <span className="work-progress-label">{label}</span>
      <span className="work-progress-track">
        <span className="work-progress-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="work-progress-percent">{percent}%</span>
    </div>
  );
}
