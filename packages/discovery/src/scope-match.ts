import type { Scope, ScopeStatus } from "@behavior-map/contracts";

export interface ScopeText {
  id?: string;
  label?: string;
  seed?: string;
  hints?: string[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function haystack(text: ScopeText): string {
  return normalize(
    [text.id, text.label, text.seed, ...(text.hints ?? [])].filter(Boolean).join(" ")
  );
}

function matchesHint(hay: string, hint: string): boolean {
  const needle = normalize(hint);
  if (!needle || !hay) {
    return false;
  }
  return hay.includes(needle) || needle.includes(hay);
}

function matchesAny(text: ScopeText, hints: string[]): boolean {
  const hay = haystack(text);
  return hints.some((hint) => matchesHint(hay, hint) || normalize(text.seed ?? "") === normalize(hint));
}

/**
 * 用 study 提示分类范围。包含/种子优先于排除，避免把发送入口标成范围外。
 */
export function classifyScope(text: ScopeText, scope: Scope): ScopeStatus {
  const seeds = scope.entry_seeds ?? [];
  const included = matchesAny(text, [...seeds, ...scope.include_hints]);
  if (included) {
    return "in_scope";
  }
  if (matchesAny(text, scope.exclude_hints)) {
    return "out_of_scope";
  }
  return "unresolved";
}
