"use strict";

const http = require("node:http");
const fs = require("node:fs");

const port = Number(process.env.PORT || 0);
const name = process.env.COMPONENT_NAME || "svc";
const failHealth = process.env.FAIL_HEALTH === "1";
const dumpEnv = process.env.DUMP_ENV_FILE;
const marker = process.env.MARKER_FILE;

if (dumpEnv) {
  fs.writeFileSync(
    dumpEnv,
    JSON.stringify({
      AGENT_API_KEY: process.env.AGENT_API_KEY ?? null,
      AGENT_TOKEN: process.env.AGENT_TOKEN ?? null
    })
  );
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url === "/health" || url === "/") {
    if (failHealth) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end(`${name} unhealthy`);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${name} ok`);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`${name} listening ${actual}`);
  if (marker) {
    fs.writeFileSync(marker, String(process.pid));
  }
});
