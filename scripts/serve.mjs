#!/usr/bin/env node
// Serves dist/ (or the folder given as the first argument) on localhost for
// local work. Zero dependencies. Usage: node scripts/serve.mjs [dir] [port]

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? process.env.PORT ?? 4321);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ics": "text/calendar; charset=utf-8",
  ".rss": "application/rss+xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = resolve(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) throw new Error("outside root");
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(port, () => console.log(`serve: http://localhost:${port} (${root})`));
