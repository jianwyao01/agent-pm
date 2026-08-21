import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import net from "node:net";
import { ensureDir } from "@behavior-map/contracts";
import { dirname } from "node:path";
import type { ComponentHealthcheck, RunPlanComponent } from "@behavior-map/contracts";

const AGENT_ENV = /^(AGENT_|CURSOR_|ANTHROPIC_|OPENAI_|CLAUDE_)/i;

export const UNIMPLEMENTED_COMPONENT_ROLES = new Set([
  "desktop",
  "rn",
  "react-native",
  "ios",
  "android",
  "game"
]);

export function isUnimplementedSlot(role: string): boolean {
  return UNIMPLEMENTED_COMPONENT_ROLES.has(role.toLowerCase());
}

export function isComposeUp(command: string): boolean {
  return /docker(?:-|\s+)compose\s+up\b/i.test(command);
}

export function isNoopCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === "true" || trimmed === ":" || trimmed === "not_started";
}

/** Agent 凭据不得进入目标应用环境。secret_ref 保持引用，不展开。 */
export function sanitizeTargetEnv(
  base: NodeJS.ProcessEnv,
  extra?: Record<string, string>
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (AGENT_ENV.test(key)) {
      continue;
    }
    out[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (AGENT_ENV.test(key)) {
        continue;
      }
      out[key] = value;
    }
  }
  return out;
}

function appendLog(logPath: string, chunk: string | Buffer): void {
  ensureDir(dirname(logPath));
  createWriteStream(logPath, { flags: "a" }).end(chunk);
}

export async function runForegroundCommand(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    logPath: string;
    timeoutMs?: number;
  }
): Promise<{ code: number | null; pid: number }> {
  ensureDir(dirname(options.logPath));
  return new Promise((resolve, reject) => {
    const log = createWriteStream(options.logPath, { flags: "a" });
    log.write(`$ ${command}\n`);
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (data: Buffer) => log.write(data));
    child.stderr?.on("data", (data: Buffer) => log.write(data));
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            killProcessTree(child.pid);
            log.write(`\n[timeout after ${options.timeoutMs}ms]\n`);
          }, options.timeoutMs)
        : undefined;
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      log.write(`\n[error] ${error.message}\n`);
      log.end();
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      log.end();
      resolve({ code, pid: child.pid ?? 0 });
    });
  });
}

export function spawnDetached(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string }
): ChildProcess {
  ensureDir(dirname(options.logPath));
  const log = createWriteStream(options.logPath, { flags: "a" });
  log.write(`$ ${command}\n`);
  const child = spawn(command, {
    cwd: options.cwd,
    env: options.env,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (data: Buffer) => log.write(data));
  child.stderr?.on("data", (data: Buffer) => log.write(data));
  child.on("close", () => {
    log.end();
  });
  child.on("error", (error) => {
    log.write(`\n[error] ${error.message}\n`);
  });
  return child;
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export async function stopProcess(pid: number | undefined, timeoutMs = 2000): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }
  killProcessTree(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(50);
  }
  if (isProcessAlive(pid)) {
    killProcessTree(pid, "SIGKILL");
    await sleep(50);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkHttp(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function checkTcp(port: number, host = "127.0.0.1", timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function waitForHealthcheck(
  healthcheck: ComponentHealthcheck,
  options: { timeoutMs: number; cwd: string; env: NodeJS.ProcessEnv; logPath: string }
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const remaining = Math.max(200, deadline - Date.now());
    let ok = false;
    if (healthcheck.kind === "http" && healthcheck.url) {
      ok = await checkHttp(healthcheck.url, Math.min(800, remaining));
    } else if (healthcheck.kind === "tcp" && typeof healthcheck.port === "number") {
      ok = await checkTcp(healthcheck.port, "127.0.0.1", Math.min(400, remaining));
    } else if (healthcheck.kind === "command" && healthcheck.command) {
      const result = await runForegroundCommand(healthcheck.command, {
        cwd: options.cwd,
        env: options.env,
        logPath: options.logPath,
        timeoutMs: Math.min(2000, remaining)
      });
      ok = result.code === 0;
    }
    if (ok) {
      appendLog(options.logPath, "[healthcheck] passed\n");
      return true;
    }
    await sleep(120);
  }
  appendLog(options.logPath, "[healthcheck] failed\n");
  return false;
}

export function resolveStartOrder(components: RunPlanComponent[]): {
  order: RunPlanComponent[];
  cycle: boolean;
} {
  const ids = new Set(components.map((component) => component.id));
  const incoming = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const component of components) {
    incoming.set(component.id, 0);
    edges.set(component.id, []);
  }
  for (const component of components) {
    for (const dep of component.depends_on) {
      if (!ids.has(dep)) {
        continue;
      }
      edges.get(dep)?.push(component.id);
      incoming.set(component.id, (incoming.get(component.id) ?? 0) + 1);
    }
  }

  const ready = components
    .filter((component) => (incoming.get(component.id) ?? 0) === 0)
    .sort(byStartOrder);
  const order: RunPlanComponent[] = [];

  while (ready.length > 0) {
    const next = ready.shift();
    if (!next) {
      break;
    }
    order.push(next);
    for (const dest of edges.get(next.id) ?? []) {
      incoming.set(dest, (incoming.get(dest) ?? 0) - 1);
      if (incoming.get(dest) === 0) {
        const destComponent = components.find((component) => component.id === dest);
        if (destComponent) {
          ready.push(destComponent);
          ready.sort(byStartOrder);
        }
      }
    }
  }

  return { order, cycle: order.length !== components.length };
}

function byStartOrder(a: RunPlanComponent, b: RunPlanComponent): number {
  return a.start_order - b.start_order || a.id.localeCompare(b.id);
}
