import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { RunContext } from "@behavior-map/contracts";
import { createContext, type SessionProviderOptions } from "./session-provider.js";

const CHROME_PATHS = ["/usr/local/bin/google-chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"];

export interface DriverSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  requests: CapturedRequest[];
  websockets: string[];
}

export interface CapturedRequest {
  method: string;
  url: string;
  resourceType: string;
}

export async function openSession(
  runContext?: Pick<RunContext, "credential_ref" | "cookie_ref">,
  sessionOptions: SessionProviderOptions = {}
): Promise<DriverSession> {
  const browser = await launchBrowser();
  const context = runContext
    ? await createContext(browser, runContext, sessionOptions)
    : await browser.newContext();
  const page = await context.newPage();
  const requests: CapturedRequest[] = [];
  const websockets: string[] = [];
  page.on("request", (request) => {
    requests.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType()
    });
  });
  page.on("websocket", (socket) => {
    websockets.push(socket.url());
  });
  return { browser, context, page, requests, websockets };
}

export async function closeSession(session: DriverSession | undefined): Promise<void> {
  if (!session) {
    return;
  }
  await session.browser.close().catch(() => undefined);
}

async function launchBrowser(): Promise<Browser> {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  try {
    return await chromium.launch({ channel: "chrome", headless: true, args });
  } catch {
    // 继续尝试系统 Chrome 路径
  }
  for (const executablePath of CHROME_PATHS) {
    try {
      return await chromium.launch({ executablePath, headless: true, args });
    } catch {
      // 尝试下一个
    }
  }
  return chromium.launch({ headless: true, args });
}

export function actualBackendFrom(requests: CapturedRequest[], pageUrl: string): {
  transport: "http" | "unknown";
  method?: string;
  path?: string;
  url?: string;
} | undefined {
  const pageOrigin = safeOrigin(pageUrl);
  const interesting = requests.filter((request) => {
    if (!["xhr", "fetch"].includes(request.resourceType) && !isFormLike(request)) {
      return false;
    }
    if (pageOrigin && safeOrigin(request.url) !== pageOrigin) {
      return false;
    }
    const path = safePath(request.url);
    return path !== "/health" && !isStaticAsset(path);
  });
  const last = interesting.at(-1);
  if (!last) {
    return undefined;
  }
  return {
    transport: "http",
    method: last.method,
    path: safePath(last.url),
    url: last.url
  };
}

function isFormLike(request: CapturedRequest): boolean {
  return request.resourceType === "other" && request.method !== "GET";
}

function isStaticAsset(path: string): boolean {
  return /\.(?:js|css|png|jpe?g|svg|ico|map|woff2?)$/i.test(path);
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
