import {
  SCHEMA_VERSION,
  stableControlId,
  type ApprovedLocator,
  type LocatorCandidate,
  type ObservedControl,
  type ObservedControlKind,
  type ObservedFacts
} from "@behavior-map/contracts";
import type { Locator, Page } from "playwright-core";

export interface DumpedNode {
  tag: string;
  role: string;
  name: string;
  placeholder: string;
  value: string;
  label: string;
  title: string;
  ariaLabel: string;
  text: string;
  id: string;
  href: string;
  seed: string;
  surface: string;
}

const QUERY =
  'button, a, input:not([type="hidden"]), textarea, select, [role="button"], [role="textbox"], [role="menuitem"], [role="link"]';

export async function dumpVisibleControls(
  page: Page,
  snapshot: string
): Promise<{ controls: ObservedControl[]; nodes: DumpedNode[] }> {
  const nodes = (await page.$$eval(QUERY, (elements) => {
    const implicitRole = (el: HTMLElement): string => {
      const explicit = el.getAttribute("role");
      if (explicit) {
        return explicit;
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "button") {
        return "button";
      }
      if (tag === "a") {
        return "link";
      }
      if (tag === "textarea") {
        return "textbox";
      }
      if (tag === "select") {
        return "combobox";
      }
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "submit" || type === "button" || type === "reset") {
          return "button";
        }
        if (type === "checkbox") {
          return "checkbox";
        }
        if (type === "radio") {
          return "radio";
        }
        return "textbox";
      }
      return "";
    };
    return elements
      .filter((node) => {
        const el = node as HTMLElement;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width + rect.height > 0
        );
      })
      .map((node) => {
        const el = node as HTMLElement;
        const labelled = el.getAttribute("aria-labelledby");
        const labelFromId = labelled
          ? labelled
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
              .trim()
          : "";
        const wrap = el.closest("label");
        const labelFor =
          (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) ||
          wrap?.textContent ||
          "";
        const name = (
          el.getAttribute("aria-label") ||
          labelFromId ||
          (el as HTMLInputElement).labels?.[0]?.textContent ||
          labelFor ||
          el.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        return {
          tag: el.tagName.toLowerCase(),
          role: implicitRole(el),
          name,
          placeholder: el.getAttribute("placeholder") ?? "",
          value: "value" in el ? String((el as HTMLInputElement).value ?? "") : "",
          label: (el.getAttribute("aria-label") || labelFromId || String(labelFor)).trim().slice(0, 80),
          title: (el.getAttribute("title") ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
          ariaLabel: (el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
          id: el.id ?? "",
          href: el.getAttribute("href") ?? "",
          seed: el.getAttribute("data-seed") ?? "",
          surface: el.closest("[data-surface]")?.getAttribute("data-surface") ?? "surface-unknown"
        };
      });
  })) as DumpedNode[];

  const controls: ObservedControl[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const observed: ObservedFacts = {
      ...(node.role ? { role: node.role } : {}),
      ...(node.name ? { name: node.name } : {}),
      ...(node.placeholder ? { placeholder: node.placeholder } : {}),
      ...(node.value ? { value: node.value } : {})
    };
    const controlId = stableControlId(snapshot, node.surface, node.role, node.name);
    if (seen.has(controlId)) {
      continue;
    }
    seen.add(controlId);
    controls.push({
      schema_version: SCHEMA_VERSION,
      control_id: controlId,
      surface_id: node.surface,
      kind: kindFrom(node),
      observed,
      locator_candidates: locatorCandidatesFor(node),
      evidence_refs: []
    });
  }
  return { controls, nodes };
}

export async function collectProbeUrls(
  page: Page,
  baseUrl: string,
  seeds: string[]
): Promise<string[]> {
  const origin = safeOrigin(baseUrl);
  const urls = new Set<string>([page.url()]);
  for (const seed of seeds) {
    if (seed.startsWith("http://") || seed.startsWith("https://") || seed.startsWith("/")) {
      try {
        urls.add(new URL(seed, baseUrl).href);
      } catch {
        // 忽略无法解析的种子
      }
    }
  }
  const hrefs = (await page.$$eval("a[href], [data-seed][href]", (elements) =>
    elements.map((el) => ({
      href: el.getAttribute("href") ?? "",
      seed: el.getAttribute("data-seed") ?? ""
    }))
  )) as Array<{ href: string; seed: string }>;
  for (const item of hrefs) {
    if (!item.href || item.href.startsWith("#") || item.href.startsWith("javascript:")) {
      continue;
    }
    const seedHit =
      Boolean(item.seed) &&
      seeds.some((seed) => seed && (item.seed === seed || item.seed.includes(seed) || seed.includes(item.seed)));
    if (!seedHit) {
      continue;
    }
    try {
      const abs = new URL(item.href, baseUrl);
      if (!origin || abs.origin === origin) {
        urls.add(abs.href);
      }
    } catch {
      // 忽略坏 href
    }
  }
  return [...urls];
}

/** execute 只等这一条 approved_locator 可见；超时即失败，不改搜。 */
export const APPROVED_LOCATOR_VISIBLE_TIMEOUT_MS = 10_000;

export function locateApproved(page: Page, approved: ApprovedLocator): Locator {
  if (approved.type === "title") {
    return page.getByTitle(approved.value.trim(), { exact: true });
  }
  if (approved.type === "label") {
    return page.getByLabel(approved.value.trim(), { exact: true });
  }
  const parsed = parseApprovedLocator(approved);
  if (!parsed?.role) {
    return page.locator(`[data-binding-invalid="${cssEscape(approved.value)}"]`);
  }
  return parsed.name
    ? page.getByRole(parsed.role as "button", { name: parsed.name, exact: true })
    : page.getByRole(parsed.role as "button");
}

/**
 * 导航后、click|type|submit 前：只等这一条 approved_locator 变为可见。
 * 超时返回 undefined，调用方必须 locator_not_found 并停止。
 */
export async function waitForApprovedVisible(
  page: Page,
  approved: ApprovedLocator,
  timeoutMs = APPROVED_LOCATOR_VISIBLE_TIMEOUT_MS
): Promise<Locator | undefined> {
  const locator = locateApproved(page, approved);
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
    return locator;
  } catch {
    return undefined;
  }
}

export function isPhase1ApprovedLocator(approved: ApprovedLocator): boolean {
  if (approved.type === "title" || approved.type === "label") {
    return approved.value.trim().length > 0;
  }
  if (approved.type !== "accessibility" && approved.type !== "role") {
    return false;
  }
  return Boolean(parseApprovedLocator(approved)?.role);
}

export function parseApprovedLocator(
  approved: ApprovedLocator
): { role: string; name?: string } | undefined {
  const raw = approved.value.trim();
  const roleName = raw.match(/^(?:role=)?([^;[\]]+);name=(.+)$/);
  if (roleName) {
    return { role: roleName[1].trim(), name: roleName[2].trim() };
  }
  const bracket = raw.match(/^(?:role=)?([^[]+)\[name=(?:"([^"]+)"|'([^']+)'|([^\]]+))\]$/);
  if (bracket) {
    return { role: bracket[1].trim(), name: (bracket[2] ?? bracket[3] ?? bracket[4]).trim() };
  }
  const colon = raw.match(/^(?:role=)?([^:]+):(.+)$/);
  if (colon) {
    return { role: colon[1].trim(), name: colon[2].trim() };
  }
  if (/^[a-z][a-z0-9_-]*$/i.test(raw.replace(/^role=/, ""))) {
    return { role: raw.replace(/^role=/, "").trim() };
  }
  return undefined;
}

function kindFrom(node: DumpedNode): ObservedControlKind {
  if (node.role === "menuitem" || node.tag === "menu") {
    return "menu";
  }
  if (node.role === "textbox" || node.tag === "input" || node.tag === "textarea" || node.tag === "select") {
    return "input";
  }
  if (node.role === "button" || node.tag === "button") {
    return "button";
  }
  return "other";
}

function locatorCandidatesFor(node: DumpedNode): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  const add = (type: LocatorCandidate["type"], value: string): void => {
    if (!value) {
      return;
    }
    if (out.some((item) => item.type === type && item.value === value)) {
      return;
    }
    out.push({ type, value });
  };
  if (node.role && node.name) {
    add("accessibility", `role=${node.role};name=${node.name}`);
    add("role", `${node.role};name=${node.name}`);
  } else if (node.role) {
    add("role", node.role);
  }
  if (node.ariaLabel) {
    add("label", node.ariaLabel);
  }
  if (node.title) {
    add("title", node.title);
  }
  if (node.label) {
    add("label", node.label);
  }
  if (node.text) {
    add("text", node.text);
  }
  if (node.id) {
    add("css", `#${node.id}`);
    add("xpath", `//*[@id=${JSON.stringify(node.id)}]`);
  }
  return out;
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function cssEscape(value: string): string {
  return value.replaceAll('"', "");
}
