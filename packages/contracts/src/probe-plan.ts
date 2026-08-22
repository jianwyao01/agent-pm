import type { ProbePlan, ProbePlanAction } from "./types.js";

/**
 * 省略 actions 时的单步默认：把 send_action 当作 binding_id，动作为 click。
 * 不回写磁盘。旧 probe-plan.yaml 无 actions 仍按此解释。
 */
export function probePlanActions(plan: ProbePlan): ProbePlanAction[] {
  if (!plan.actions || plan.actions.length === 0) {
    return [{ binding_id: plan.send_action, action: "click" }];
  }
  return plan.actions.map((step) => ({
    binding_id: step.binding_id,
    action: step.action,
    ...(step.value !== undefined ? { value: step.value } : {})
  }));
}

/** 发送步：action 为 submit 的最后一步；若无 submit，则为最后一步 click。 */
export function lastSendBindingId(actions: ProbePlanAction[]): string | undefined {
  const submits = actions.filter((step) => step.action === "submit");
  if (submits.length > 0) {
    return submits.at(-1)?.binding_id;
  }
  const clicks = actions.filter((step) => step.action === "click");
  return clicks.at(-1)?.binding_id;
}

/** actions 只能写 binding_id，禁止 CSS 选择器或语义目标。 */
export function looksLikeCssOrSemanticGoal(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return true;
  }
  if (/^[#.\[\]]/.test(text)) {
    return true;
  }
  if (/[#[\]=]/.test(text)) {
    return true;
  }
  if (/aria-label|getByRole/i.test(text)) {
    return true;
  }
  if (/^(css|xpath|role):/i.test(text)) {
    return true;
  }
  if (/^(send_message|login)$/i.test(text)) {
    return true;
  }
  return false;
}

export function validateProbePlanRules(plan: ProbePlan): string[] {
  const issues: string[] = [];
  if (!plan.actions || plan.actions.length === 0) {
    return issues;
  }
  const sendId = lastSendBindingId(plan.actions);
  if (!sendId) {
    issues.push("probe-plan.actions 缺少发送步（submit 或 click）");
  } else if (plan.send_action !== sendId) {
    issues.push(`send_action 必须等于最后发送步的 binding_id（期望 ${sendId}，实际 ${plan.send_action}）`);
  }
  for (const step of plan.actions) {
    if (looksLikeCssOrSemanticGoal(step.binding_id)) {
      issues.push(`actions 只能写 binding_id，禁止 CSS 或语义目标: ${step.binding_id}`);
    }
  }
  return issues;
}
