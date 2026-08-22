"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.PORT || 0);
const publicDir = path.join(__dirname, "public");

const items = [{ id: "seed-1", text: "已有条目" }];
const created = [];
let seq = 1;
let loginPosted = false;

function cookiesOf(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isAuthed(req) {
  return cookiesOf(req).some((part) => part === "bm_session=ok");
}

function needsAuth(pathname) {
  return (
    pathname !== "/health" &&
    pathname !== "/login" &&
    pathname !== "/debug/login-posted" &&
    pathname !== "/api/items" &&
    pathname !== "/api/created"
  );
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendFile(res, file, type) {
  res.writeHead(200, { "content-type": type });
  res.end(fs.readFileSync(file));
}

function sendHtml(res, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

// 延迟页不落盘为 .html，避免 M4 scan 把尚未绘制的控件当成静态候选。
function lateComposePage() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>延迟撰写面</title>
  </head>
  <body>
    <main id="surface-target" data-surface="surface-target" data-role="current" aria-label="撰写面">
      <h1>延迟撰写面</h1>
      <div id="mount"></div>
      <p id="status"></p>
      <ul id="item-list" data-collection="list"></ul>
      <button type="button" id="control-last-decoy" aria-label="最后一个按钮">最后一个按钮</button>
    </main>
    <script>
      const params = new URLSearchParams(location.search);
      const never = params.get("paint") === "never";
      const rawDelay = Number(params.get("delay") || 500);
      const delay = Number.isFinite(rawDelay) ? Math.min(800, Math.max(300, rawDelay)) : 500;

      async function loadItems() {
        const res = await fetch("/api/items");
        const items = await res.json();
        const ul = document.getElementById("item-list");
        if (!ul) {
          return;
        }
        ul.innerHTML = items
          .map((item) => "<li data-item-id=\\"" + item.id + "\\">" + item.text + "</li>")
          .join("");
      }

      async function postItem(text) {
        await fetch("/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text })
        });
        document.getElementById("status").textContent = "已发送: " + text;
        await loadItems();
      }

      function paintBound() {
        const mount = document.getElementById("mount");
        const form = document.createElement("form");
        form.id = "send-form";
        const input = document.createElement("textarea");
        input.id = "compose-input";
        input.name = "text";
        input.setAttribute("aria-label", "输入");
        const button = document.createElement("button");
        button.type = "submit";
        button.id = "control-send";
        button.setAttribute("aria-label", "发送一条消息");
        button.textContent = "发送";
        form.appendChild(input);
        form.appendChild(button);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const raw = document.getElementById("compose-input").value;
          const text = String(raw || "").trim() || "probe-item";
          await postItem(text);
        });
        mount.replaceChildren(form);
      }

      document.getElementById("control-last-decoy").addEventListener("click", async () => {
        await postItem("decoy-fallback");
      });

      loadItems();
      if (!never) {
        setTimeout(paintBound, delay);
      }
    </script>
  </body>
</html>
`;
}

// 现场 SPA：Send 在撰写框为空时禁用。两次独立浏览器会丢掉已输入文本。
function liveComposePage() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>现场撰写面</title>
  </head>
  <body>
    <main id="surface-target" data-surface="surface-target" data-role="current" aria-label="撰写面">
      <h1>现场撰写面</h1>
      <form id="send-form">
        <textarea id="compose-input" name="text" aria-label="输入"></textarea>
        <button type="submit" id="control-send" aria-label="发送一条消息" disabled>发送</button>
      </form>
      <p id="status"></p>
      <ul id="item-list" data-collection="list"></ul>
    </main>
    <script>
      const input = document.getElementById("compose-input");
      const send = document.getElementById("control-send");
      function syncSend() {
        send.disabled = !String(input.value || "").trim();
      }
      input.addEventListener("input", syncSend);
      syncSend();

      async function loadItems() {
        const res = await fetch("/api/items");
        const items = await res.json();
        const ul = document.getElementById("item-list");
        if (!ul) {
          return;
        }
        ul.innerHTML = items
          .map((item) => "<li data-item-id=\\"" + item.id + "\\">" + item.text + "</li>")
          .join("");
      }

      document.getElementById("send-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = String(input.value || "").trim();
        if (!text || send.disabled) {
          return;
        }
        await fetch("/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text })
        });
        document.getElementById("status").textContent = "已发送: " + text;
        await loadItems();
      });
      loadItems();
    </script>
  </body>
</html>
`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const params = new URLSearchParams(raw);
        resolve(Object.fromEntries(params.entries()));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url.pathname === "/debug/login-posted") {
    sendJson(res, 200, { posted: loginPosted });
    return;
  }
  if (url.pathname === "/login") {
    if (req.method === "POST") {
      loginPosted = true;
      fs.writeFileSync(path.join(__dirname, "login-posted.flag"), "1");
      sendJson(res, 200, { ok: false, message: "fixture login is not used by execute" });
      return;
    }
    sendFile(res, path.join(publicDir, "login.html"), "text/html; charset=utf-8");
    return;
  }
  if (needsAuth(url.pathname) && !isAuthed(req) && req.method === "GET") {
    res.writeHead(302, { location: "/login" });
    res.end();
    return;
  }
  if (url.pathname === "/api/items") {
    sendJson(res, 200, items);
    return;
  }
  if (url.pathname === "/api/created") {
    sendJson(res, 200, created);
    return;
  }
  if (url.pathname === "/create" && req.method === "POST") {
    if (!isAuthed(req)) {
      sendJson(res, 401, { ok: false });
      return;
    }
    const body = await parseBody(req);
    const name = String(body.name || "").trim();
    if (name) {
      seq += 1;
      const id = `created-${seq}`;
      created.push({ id, name });
      items.push({ id, text: name });
    }
    sendJson(res, 200, { ok: true, created, items });
    return;
  }
  if (url.pathname === "/send" && req.method === "POST") {
    if (!isAuthed(req)) {
      sendJson(res, 401, { ok: false });
      return;
    }
    const body = await parseBody(req);
    const text = String(body.text || "").trim();
    if (text) {
      seq += 1;
      items.push({ id: `item-${seq}`, text });
    }
    sendJson(res, 200, { ok: true, items });
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    return;
  }
  if (url.pathname === "/compose" || url.pathname === "/compose.html") {
    sendFile(res, path.join(publicDir, "compose.html"), "text/html; charset=utf-8");
    return;
  }
  if (url.pathname === "/create" || url.pathname === "/create.html") {
    sendFile(res, path.join(publicDir, "create.html"), "text/html; charset=utf-8");
    return;
  }
  if (url.pathname === "/compose-late" || url.pathname === "/compose-late.html") {
    sendHtml(res, lateComposePage());
    return;
  }
  if (url.pathname === "/compose-live" || url.pathname === "/compose-live.html") {
    sendHtml(res, liveComposePage());
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`two-surface listening ${actual}`);
});
