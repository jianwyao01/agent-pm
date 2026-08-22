"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.PORT || 0);
const publicDir = path.join(__dirname, "public");

const items = [{ id: "seed-1", text: "已有条目" }];
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
    pathname !== "/api/items"
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
  res.writeHead(404);
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`two-surface listening ${actual}`);
});
