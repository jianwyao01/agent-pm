import type { Scope, Study } from "./types.js";

/** 范围来自 study 提示，而不是核心硬编码的业务词。 */
export function scopeFromStudy(study: Study, scopeId = study.id): Scope {
  return {
    id: scopeId,
    include_hints: [...study.include_hints],
    exclude_hints: [...study.exclude_hints],
    entry_seeds: [...study.entry_seeds]
  };
}
