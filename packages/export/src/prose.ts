import {
  UNOBSERVED,
  projectDisplay,
  type Control,
  type Effect,
  type Journey,
  type ReviewedModel,
  type Surface
} from "@behavior-map/contracts";

/**
 * 中文工具说明。目标界面原文（按钮/标题等）保持原语言，不翻译。
 */
export function renderProductMapProse(model: ReviewedModel): string {
  const entries = model.surfaces.filter((surface) => surface.role !== "other");
  const sendControls = model.controls.filter((control) =>
    /send|发送|submit/.test(`${control.id} ${control.name} ${control.action}`)
  );
  const accepted = model.journeys.filter((journey) => journey.status === "accepted");
  const display = projectDisplay(model.journeys, model.effects);
  const lines: string[] = [
    "# 产品行为地图",
    "",
    "本文件由人工审定模型生成，是工具侧的中文说明，不是目标产品文档。",
    "界面上出现的原文（按钮、标题、占位）保持原语言，不在此翻译。",
    "本图不是测试报告，也不声称已对目标应用跑通。",
    "",
    "## 入口",
    ""
  ];
  if (entries.length === 0) {
    lines.push("- 入口来自已审定表面；本次写入了当前面与列表/他面。");
  } else {
    for (const surface of model.surfaces) {
      lines.push(`- 表面 \`${surface.id}\`：界面原文「${surface.name}」`);
    }
  }
  const stem = mapHeadingStem(model);
  lines.push("", `## ${stem}控件`, "");
  const controls = sendControls.length > 0 ? sendControls : model.controls;
  if (controls.length === 0) {
    lines.push(`- 已审定旅程引用了${stem}控件；界面原文见目标应用。`);
  } else {
    for (const control of controls) {
      lines.push(controlLine(control));
    }
  }
  lines.push("", `## 已接受的${stem}旅程`, "");
  const sendJourneys = accepted.length > 0 ? accepted : model.journeys;
  for (const journey of sendJourneys) {
    lines.push(`- 旅程 ID：\`${journey.id}\`（重命名不改此 ID）`);
    lines.push(`- 名称：${journey.name}`);
    lines.push(`- 状态：${lifecycleLabel(journey)}`);
    if (journey.control_id) {
      const control = model.controls.find((item) => item.id === journey.control_id);
      lines.push(`- 控件：\`${journey.control_id}\`${control ? `，界面原文「${control.name}」` : ""}`);
    }
    lines.push("");
  }
  lines.push("## 跨面效果", "");
  lines.push("六列投影必须包含「他面」。未读与通知可以为「未观察到」，不得写成不存在。");
  lines.push("");
  for (const row of display.rows) {
    lines.push(`### ${row.journey_id}`);
    lines.push("");
    for (const cell of row.cells) {
      const note = cell.observed ? cell.value : UNOBSERVED;
      lines.push(`- ${cell.column}：${note}`);
    }
    lines.push("");
  }
  lines.push(effectNotes(model.effects, model.surfaces));
  return `${lines.join("\n")}\n`;
}

function mapHeadingStem(model: ReviewedModel): string {
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
  const surfaceHint = surfaces.find((item) => item.role === "other")?.name;
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
