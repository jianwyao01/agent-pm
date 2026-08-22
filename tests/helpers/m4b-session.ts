import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  writeJsonl,
  type Binding,
  type Control
} from "@behavior-map/contracts";

export function writeStorageState(file: string, originHost = "127.0.0.1"): void {
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: "bm_session",
            value: "ok",
            domain: originHost,
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: "Lax"
          }
        ],
        origins: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

export function writeHumanBinding(
  runRoot: string,
  binding: Pick<Binding, "binding_id" | "control_id" | "approved_locator">
): Binding {
  const row: Binding = {
    schema_version: SCHEMA_VERSION,
    binding_id: binding.binding_id,
    control_id: binding.control_id,
    approved_locator: binding.approved_locator,
    approved_by: "human",
    created_at: "2026-08-22T00:00:00.000Z"
  };
  writeJsonl(join(runRoot, "bindings.jsonl"), [row]);
  return row;
}

export function boundAction(binding: Binding, extras: Partial<Control> = {}): Control {
  return {
    id: extras.id ?? binding.control_id,
    surface_id: extras.surface_id ?? "surface-target",
    name: extras.name ?? "发送一条消息",
    action: extras.action ?? "submit",
    binding_id: binding.binding_id,
    ...extras
  };
}

export function boundSubmitAction(binding: Binding, extras: Partial<Control> = {}): Control {
  return boundAction(binding, { action: "submit", ...extras });
}

export function boundTypeAction(binding: Binding, value: string, extras: Partial<Control> = {}): Control {
  return boundAction(binding, { action: "type", name: extras.name ?? "输入", value, ...extras });
}
