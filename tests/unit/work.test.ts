import { describe, expect, it } from 'vitest';
import { workFraction } from '../../src/ui/shell/WorkProgress';

describe('workFraction', () => {
  it('runs the saved-mesh stages one after the other to 100%', () => {
    const stages = [
      workFraction({ stage: 'materials', done: 0, total: 1 }),
      workFraction({ stage: 'materials', done: 1, total: 1 }),
      workFraction({ stage: 'meshes', done: 500, total: 1000 }),
      workFraction({ stage: 'meshes', done: 1000, total: 1000 }),
    ];
    expect(stages[0]).toBe(0);
    expect(stages.at(-1)).toBe(1);
    for (let i = 1; i < stages.length; i++) expect(stages[i]!).toBeGreaterThanOrEqual(stages[i - 1]!);
  });

  it('measures the first build on its own', () => {
    expect(workFraction({ stage: 'build-initial', done: 40, total: 100 })).toBeCloseTo(0.4);
    expect(workFraction({ stage: 'meshes', done: 0, total: 0 })).toBeCloseTo(0.02);
  });
});
