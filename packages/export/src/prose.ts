import {
  OBSERVED,
  UNOBSERVED,
  projectDisplay,
  type Binding,
  type Control,
  type Effect,
  type Journey,
  type ReviewedModel,
  type Surface
} from "@behavior-map/contracts";
import {
  isBlockedSurfaceName,
  mapAffectedParties,
  mapCombinations,
  mapKeepReason,
  type ProductMapContext,
  unobservedCells
} from "./map-context.js";

/**
 * 中文工具说明。目标界面原文（按钮/标题等）保持原语言，不翻译。
 */
export function renderProductMapProse(model: ReviewedModel, extras?: ProductMapContext): string {
  const accepted = model.journeys.filter((journey) => journey.status === "accepted");
  const display = projectDisplay(model.journeys, model.effects);
  const bindings = extras?.bindings ?? [];
  const stem = mapHeadingStem(model);
  const lines: string[] = [
    "# 产品行为地图",
    "",
    "本文件由人工审定模型生成，是工具侧的中文说明，不是目标产品文档。",
    "界面上出现的原文（按钮、标题、占位）保持原语言，不在此翻译。",
    "本图不是测试报告，也不声称已对目标应用跑通。",
    "",
    ...overviewLines(model, extras),
    "## 入口",
    ""
  ];
  if (accepted.length === 0) {
    lines.push("- 未识别");
  } else {
    for (const journey of accepted) {
      lines.push(`- ${entryLine(journey, bindings)}`);
    }
  }
  lines.push("", `## ${stem}控件`, "");
  const controls = referencedControls(model, bindings);
  if (controls.length === 0) {
    lines.push(`- 已审定旅程引用了${stem}控件；界面原文见目标应用。`);
  } else {
    for (const control of controls) {
      lines.push(controlLine(control));
    }
  }
  lines.push("", `## 已接受的${stem}旅程`, "");
  const listed = accepted.length > 0 ? accepted : model.journeys;
  for (const journey of listed) {
    lines.push(`- 旅程 ID：\`${journey.id}\`（重命名不改此 ID）`);
    lines.push(`- 名称：${journey.name}`);
    lines.push(`- 状态：${lifecycleLabel(journey)}`);
    if (journey.control_id) {
      const control = model.controls.find((item) => item.id === journey.control_id);
      lines.push(`- 控件：\`${journey.control_id}\`${control ? `，界面原文「${control.name}」` : ""}`);
    }
    lines.push(`- 受影响方：${mapAffectedParties(journey.affected_parties)}`);
    lines.push(`- 入口：${entryLine(journey, bindings)}`);
    lines.push(`- 步骤：`);
    lines.push(...stepLines(journey, bindings));
    lines.push(`- 轨迹：${trajectoryLine(journey, extras)}`);
    lines.push(`- 组合：${mapCombinations(journey.combinations)}`);
    lines.push(`- 保留理由：${mapKeepReason(journey.keep_reason)}`);
    lines.push("");
  }
  lines.push("## 跨面效果", "");
  lines.push("六列投影必须包含「他面」。未读与通知可以为「未观察到」，不得写成不存在。");
  lines.push("");
  for (const row of display.rows) {
    lines.push(`### ${row.journey_id}`);
    lines.push("");
    for (const cell of row.cells) {
      const note = cell.observed ? OBSERVED : UNOBSERVED;
      lines.push(`- ${cell.column}：${note}`);
    }
    lines.push("");
  }
  lines.push(effectNotes(model.effects, model.surfaces));
  return `${lines.join("\n")}\n`;
}

function overviewLines(model: ReviewedModel, extras?: ProductMapContext): string[] {
  const accepted = model.journeys.filter((journey) => journey.status === "accepted");
  const entries = accepted.map((journey) => journey.entry_url?.trim() || "未识别");
  const candidateScale = extras?.candidateLineCount ?? 0;
  const rejected = extras?.rejectedCount ?? model.decisions.filter((item) => item.review_status === "rejected").length;
  const unreviewed = extras?.unreviewedCount ?? 0;
  const cellGaps = unobservedCells(model);
  const gaps: string[] = [`未审定候选 ${unreviewed}`];
  for (const cell of cellGaps) {
    gaps.push(cell);
  }
  if (!extras?.hasValidStatic) {
    gaps.push("静态扫描未落盘");
  }
  const deleted = model.decisions.filter((item) => item.review_status === "rejected" && item.rejection_reason);
  const lines = [
    "## 概览",
    "",
    `- 入口清单：${entries.length > 0 ? entries.join("；") : "未识别"}`,
    `- 已发现候选规模：${candidateScale}`,
    `- 保留几条：${accepted.length}`,
    `- 删了几条：${rejected}`,
    `- 显式 Gap：${gaps.join("；")}`,
    ""
  ];
  if (deleted.length > 0) {
    lines.push("- 已删除：");
    for (const item of deleted) {
      lines.push(`  - \`${item.candidate_id}\`：${item.rejection_reason}`);
    }
    lines.push("");
  }
  return lines;
}

function entryLine(journey: Journey, bindings: Binding[]): string {
  const url = journey.entry_url?.trim() || "未识别";
  const first = journey.steps?.[0];
  const binding = first ? bindings.find((row) => row.binding_id === first.binding_id) : undefined;
  if (!binding) {
    return url;
  }
  const loc = `${binding.approved_locator.type} ${binding.approved_locator.value}`;
  return `${url}；首步 ${loc}`;
}

function stepLines(journey: Journey, bindings: Binding[]): string[] {
  const steps = journey.steps ?? [];
  if (steps.length === 0) {
    return ["  - 未写步骤"];
  }
  return steps.map((step) => {
    const binding = bindings.find((row) => row.binding_id === step.binding_id);
    if (!binding) {
      return `  - ${step.action}`;
    }
    return `  - ${step.action} ${binding.approved_locator.type} ${binding.approved_locator.value}`;
  });
}

function trajectoryLine(journey: Journey, extras?: ProductMapContext): string {
  const urls = (extras?.playUrlsByJourney[journey.id] ?? []).filter((url) => !isBlockedSurfaceName(url));
  if (urls.length === 0) {
    return UNOBSERVED;
  }
  return urls.join(" → ");
}

function referencedControls(model: ReviewedModel, bindings: Binding[]): Control[] {
  const accepted = model.journeys.filter((journey) => journey.status === "accepted");
  const bindingById = new Map(bindings.map((row) => [row.binding_id, row]));
  const ids = new Set<string>();
  for (const journey of accepted) {
    if (journey.control_id) {
      ids.add(journey.control_id);
    }
    for (const step of journey.steps ?? []) {
      const binding = bindingById.get(step.binding_id);
      if (binding) {
        ids.add(binding.control_id);
      }
    }
  }
  return model.controls.filter((control) => {
    if (control.id.startsWith("bind-") && !hasBinding(control, bindings)) {
      return false;
    }
    return ids.has(control.id);
  });
}

function hasBinding(control: Control, bindings: Binding[]): boolean {
  return bindings.some(
    (row) =>
      row.binding_id === control.id ||
      row.binding_id === control.binding_id ||
      row.control_id === control.id
  );
}

export function mapHeadingStem(model: ReviewedModel): string {
  const accepted = model.journeys.filter((journey) => journey.status === "accepted");
  const pool = accepted.length > 0 ? accepted : model.journeys;
  if (pool.some(isSendNamedJourney)) {
    return "发送";
  }
  for (const journey of pool) {
    const cap = model.capabilities.find(
      (item) => journey.control_id !== undefined && item.control_ids.includes(journey.control_id)
    );
    if (cap && cap.name !== "发送") {
      return cap.name;
    }
  }
  const named = pool.find((journey) => journey.name.trim());
  if (named) {
    return named.name;
  }
  const derived = model.capabilities.find((item) => item.name !== "发送");
  return derived?.name ?? "旅程";
}

function isSendNamedJourney(journey: Journey): boolean {
  const text = `${journey.id} ${journey.name}`;
  return /发送/.test(text) || /(?:^|-)send(?:-|$)/i.test(journey.id.replace(/^jny-/, ""));
}

function controlLine(control: Control): string {
  const locator = control.locator?.value ? `，locator \`${control.locator.value}\`` : "";
  return `- 控件 \`${control.id}\`：界面原文「${control.name}」，动作 ${control.action}${locator}`;
}

function lifecycleLabel(journey: Journey): string {
  if (journey.status === "accepted") {
    return "已接受";
  }
  if (journey.status === "stale") {
    return "stale（本 run 未再观察到，未删除）";
  }
  return "not_observed（本 run 未观察到，未删除）";
}

function effectNotes(effects: Effect[], surfaces: Surface[]): string {
  const other = effects.find((item) => item.observation.kind === "other_surface");
  const surfaceHint = surfaces.find((item) => item.role === "other" && !isBlockedSurfaceName(item.name))?.name;
  const otherText = other
    ? other.observation.observed
      ? other.observation.display_value
      : UNOBSERVED
    : UNOBSERVED;
  return [
    "## 说明",
    "",
    `- 他面列已写出，当前值为「${otherText}」${surfaceHint ? `；对应表面原文「${surfaceHint}」` : ""}。`,
    "- 未读 / 通知若未执行，只记未观察到。",
    "- 后台只记录实际观察到的传输，不编造 method+path。",
    ""
  ].join("\n");
}
