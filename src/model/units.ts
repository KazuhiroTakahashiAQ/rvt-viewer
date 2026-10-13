/*
 * Length/area/volume conversion and formatting. rvt-rs works in feet; the
 * viewer displays in the project's metric unit (Japanese Revit default: mm).
 */

export const FEET_TO_METRES = 0.3048;

export type LengthUnit = 'mm' | 'm';

export interface UnitSettings {
  length: LengthUnit;
}

export const DEFAULT_UNITS: UnitSettings = { length: 'mm' };

const nf = (locale: string, digits: number) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function formatLength(feet: number, unit: LengthUnit, locale: string): string {
  const metres = feet * FEET_TO_METRES;
  return unit === 'mm' ? nf(locale, 0).format(metres * 1000) : nf(locale, 3).format(metres);
}

export function lengthSuffix(unit: LengthUnit): string {
  return unit;
}

export function formatArea(squareFeet: number, locale: string): string {
  return nf(locale, 2).format(squareFeet * FEET_TO_METRES * FEET_TO_METRES);
}

export function formatVolume(cubicFeet: number, locale: string): string {
  return nf(locale, 3).format(cubicFeet * FEET_TO_METRES ** 3);
}

export function formatAngle(radians: number, locale: string): string {
  return nf(locale, 2).format((radians * 180) / Math.PI);
}

export function formatNumber(value: number, locale: string, digits = 2): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}
