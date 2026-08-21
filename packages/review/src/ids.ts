import { assignJourneyId } from "@behavior-map/contracts";

export function nameToJourneySlug(name: string): string {
  if (/发送/.test(name)) {
    return "send";
  }
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || "journey";
}

export function nextJourneyId(name: string, existingIds: Iterable<string>): string {
  const used = new Set(existingIds);
  const slug = nameToJourneySlug(name);
  const first = assignJourneyId(slug);
  if (!used.has(first)) {
    return first;
  }
  let n = 1;
  while (used.has(assignJourneyId(`${slug}-${String(n).padStart(3, "0")}`))) {
    n += 1;
  }
  return assignJourneyId(`${slug}-${String(n).padStart(3, "0")}`);
}

export function effectIdFor(kind: string, subtype?: string, index = 0): string {
  const stem = subtype ? `${kind}-${subtype}` : kind;
  return index === 0 ? `eff-${stem}` : `eff-${stem}-${index + 1}`;
}
