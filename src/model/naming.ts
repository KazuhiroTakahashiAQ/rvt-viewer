/*
 * rvt-rs names elements `Family:Type:ElementId` (plus `:n` for extra sketch
 * pieces), or `<RevitClass>-<ElementId>` when family/type are unknown.
 */

export interface ParsedName {
  family: string | null;
  type: string | null;
  elementId: string | null;
}

export function splitElementName(name: string): ParsedName {
  const parts = name.split(':');
  if (parts.length >= 3) {
    // Trailing `:n` piece counter after the ElementId.
    let end = parts.length;
    if (end >= 4 && /^\d+$/.test(parts[end - 1]!) && /^\d+$/.test(parts[end - 2]!)) end -= 1;
    const elementId = parts[end - 1]!;
    if (/^\d+$/.test(elementId)) {
      return {
        family: parts[0] || null,
        type: parts.slice(1, end - 1).join(':') || null,
        elementId,
      };
    }
  }
  const dash = /^(.*)-(\d+)$/.exec(name);
  if (dash) return { family: null, type: null, elementId: dash[2]! };
  return { family: null, type: null, elementId: null };
}

/** `Family : Type` label as Revit shows in the type selector. */
export function familyTypeLabel(family: string, type: string): string {
  if (family && type) return `${family} : ${type}`;
  return family || type;
}
