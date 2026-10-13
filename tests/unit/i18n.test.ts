import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ja from '../../src/i18n/locales/ja.json';
import { CATEGORY_ORDER } from '../../src/model/categories';

type Dict = { [k: string]: string | Dict };

function has(dict: Dict, key: string): boolean {
  let cur: string | Dict | undefined = dict;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return false;
    cur = cur[part];
  }
  return typeof cur === 'string';
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'pkg' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('ja locale', () => {
  const dict = ja as Dict;
  const src = sourceFiles(join(__dirname, '../../src'));

  it('defines every static key used in the source', () => {
    const missing = new Set<string>();
    const re = /\bt\(\s*'([a-zA-Z0-9_.]+)'/g;
    for (const file of src) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(re)) if (!has(dict, m[1]!)) missing.add(`${m[1]} (${file})`);
    }
    expect([...missing]).toEqual([]);
  });

  it('defines keys built from enumerations', () => {
    const keys = [
      ...CATEGORY_ORDER.map((c) => `category.${c}`),
      ...['wireframe', 'hiddenLine', 'shaded', 'consistentColors'].map((s) => `visualStyle.${s}`),
      ...['init', 'metadata', 'parse', 'scene', 'geometry', 'schedule'].map((s) => `loading.step.${s}`),
      ...['geometry', 'typed_no_geometry', 'diagnostic_partial', 'proxy_only', 'scaffold'].map((s) => `confidence.${s}`),
      ...['notRevit', 'unsupportedVersion', 'outOfMemory', 'unknown'].map((s) => `loadError.${s}`),
      ...['east', 'north', 'south', 'west'].map((d) => `view.direction.${d}`),
      ...['plan', '3d', 'elevation', 'schedule'].flatMap((k) => [`view.kind.${k}`, `view.kindPrefix.${k}`]),
      ...['elements', 'rooms'].map((k) => `view.schedule.${k}`),
      ...['light', 'dark', 'system'].map((k) => `options.themes.${k}`),
      ...['white', 'gray', 'black'].map((k) => `options.backgrounds.${k}`),
      ...['mm', 'm'].map((k) => `units.${k}`),
      'language.ja',
      'prop.joinStart',
      'prop.joinEnd',
      'value.yes',
      'value.no',
    ];
    expect(keys.filter((k) => !has(dict, k))).toEqual([]);
  });

  it('has no hard-coded Japanese text in components', () => {
    const offenders: string[] = [];
    for (const file of src.filter((f) => f.endsWith('.tsx'))) {
      const text = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));
      text.forEach((line, i) => {
        if (/[぀-ヿ一-龯]/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
