// notion-mcp-windows — a least-privilege MCP server for a Windows PC.
//
// What this does:
//   Exposes four tools (run_command, list_dir, read_file, write_file) to an
//   MCP client such as Notion AI, over HTTP on 127.0.0.1, guarded by a token.
//
// What this deliberately does NOT do:
//   It does not enforce a path allowlist in code. What the connected AI can
//   actually touch is decided by Windows itself: run this process as a
//   dedicated low-privilege user account, keep that account out of
//   everything by default, and grant it access only to the folders you
//   choose. The OS is the sandbox — see "Security model" in the README.
//
// Windows only — the permission model this project is built around is
// Windows ACLs, and run_command is PowerShell. No third-party
// dependencies. Requires Node.js 18+ on Windows 10/11.
//
// Configuration, first match wins:
//   1. Environment variables (MCP_ROOT, MCP_BASE, MCP_PORT, ...)
//   2. config.local.json next to this file (copy config/config.example.json)
//   3. Built-in defaults listed below
// The startup banner prints the effective configuration, so if something
// behaves unexpectedly, look there first. The token itself is never printed.

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

// --- Configuration ----------------------------------------------------------

const CONFIG_PATH = process.env.MCP_CONFIG || path.join(SERVER_DIR, "config.local.json");
let fileConfig = {};
if (existsSync(CONFIG_PATH)) {
  try {
    fileConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error(`Could not parse config file ${CONFIG_PATH}: ${e.message}`);
    process.exit(1);
  }
}
const pick = (envName, configKey, fallback) =>
  process.env[envName] ?? fileConfig[configKey] ?? fallback;

const ROOT = pick("MCP_ROOT", "root", path.join(SERVER_DIR, "work"));
const BASE = pick("MCP_BASE", "base", SERVER_DIR);
const PORT = Number(pick("MCP_PORT", "port", 8787));
const MAX_READ = Number(pick("MCP_MAX_READ", "maxReadBytes", 200 * 1024));
const TOKEN_FILE = pick("MCP_TOKEN_FILE", "tokenFile", path.join(BASE, "token.txt"));
const LOG_DIR = path.join(BASE, "logs");

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid port: ${PORT}. Check MCP_PORT / "port" in the config file.`);
  process.exit(1);
}
if (!(MAX_READ > 0)) {
  console.error(`Invalid max read size: ${MAX_READ}. Check MCP_MAX_READ / "maxReadBytes".`);
  process.exit(1);
}

// --- Token (fail closed) ------------------------------------------------------
// The token is a single shared secret. The server refuses to start without
// one and never generates one itself — create it on purpose, keep it out of
// git, and rotate it if it has ever been pasted anywhere (see README).
if (!existsSync(TOKEN_FILE)) {
  console.error(`Token file not found: ${TOKEN_FILE}`);
  console.error("Generate a token and save the output as that file, e.g.:");
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
if (TOKEN.length < 32) {
  console.error(`Token in ${TOKEN_FILE} is too short (${TOKEN.length} chars). Use at least 32 random characters.`);
  process.exit(1);
}

// The default working directory is created on purpose: a missing cwd makes
// every run_command fail later with a much less obvious error.
try {
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  console.error(`Could not create working/log directory: ${e.message}`);
  console.error(`  root: ${ROOT}`);
  console.error(`  logs: ${LOG_DIR}`);
  console.error("Does the account running this server have write access there?");
  process.exit(1);
}

const AUDIT = path.join(LOG_DIR, "audit.log");
const audit = (line) => {
  try {
    appendFileSync(AUDIT, `${new Date().toISOString()} ${line}\n`);
  } catch {}
};
const resolveP = (p = ".") => path.resolve(ROOT, p);

// --- Tools -----------------------------------------------------------------

function runCommand(command, cwd, timeoutSec) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve(
        "Error: run_command is Windows-only (it runs PowerShell). " +
          "This server is designed for Windows — see README, Limitations."
      );
      return;
    }
    const script =
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; " +
      command;
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { cwd, windowsHide: true }
    );
    let out = "",
      err = "",
      killed = false;
    const cap = (s, d) => (s.length < 100000 ? s + d : s);
    child.stdout.on("data", (d) => (out = cap(out, d.toString("utf8"))));
    child.stderr.on("data", (d) => (err = cap(err, d.toString("utf8"))));
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(`Failed to start: ${e.message} (cwd: ${cwd})`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(
        `Exit code: ${killed ? "killed (timeout)" : code}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`
      );
    });
  });
}

const P = { type: "string", description: `Absolute path, or relative to ${ROOT}` };
const tools = [
  {
    name: "run_command",
    description:
      "Run a PowerShell command on this Windows PC, with the permissions of the account running the service",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { ...P, description: `Working directory, default ${ROOT}` },
        timeout_sec: { type: "number", description: "Timeout in seconds, default 120, max 1800" },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "list_dir",
    description: "List a directory (read-only)",
    inputSchema: { type: "object", properties: { path: P } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_file",
    description: "Read a text file (read-only, size-capped)",
    inputSchema: {
      type: "object",
      properties: { path: P },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_file",
    description: "Write a text file (UTF-8, overwrites, creates parent folders)",
    inputSchema: {
      type: "object",
      properties: { path: P, content: { type: "string" } },
      required: ["path", "content"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
];

async function callTool(name, args = {}) {
  if (name === "run_command") {
    const t = Math.min(Math.max(Number(args.timeout_sec) || 120, 1), 1800);
    audit(`run_command cwd=${resolveP(args.cwd)} cmd=${JSON.stringify(args.command)}`);
    return await runCommand(String(args.command), resolveP(args.cwd), t);
  }
  if (name === "list_dir") {
    audit(`list_dir ${resolveP(args.path)}`);
    const items = await fs.readdir(resolveP(args.path), { withFileTypes: true });
    return items.map((d) => (d.isDirectory() ? "[DIR]  " : "[FILE] ") + d.name).join("\n") || "(empty directory)";
  }
  if (name === "read_file") {
    const file = resolveP(args.path);
    audit(`read_file ${file}`);
    const st = await fs.stat(file);
    if (!st.isFile()) throw new Error("Not a file");
    if (st.size > MAX_READ) throw new Error(`File exceeds the ${MAX_READ}-byte read limit`);
    return await fs.readFile(file, "utf8");
  }
  if (name === "write_file") {
    const file = resolveP(args.path);
    audit(`write_file ${file} (${String(args.content).length} chars)`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, String(args.content), "utf8");
    return `Written: ${file}`;
  }
  throw new Error("Unknown tool: " + name);
}

// --- MCP over Streamable HTTP (minimal, hand-rolled) ------------------------

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification, no reply
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  try {
    if (method === "initialize") {
      const v = VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0];
      return ok({
        protocolVersion: v,
        capabilities: { tools: {} },
        serverInfo: { name: "notion-mcp-windows", version: "0.3.1" },
      });
    }
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools });
    if (method === "tools/call") {
      try {
        const text = await callTool(params?.name, params?.arguments);
        return ok({ content: [{ type: "text", text }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: "Error: " + e.message }], isError: true });
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } };
  }
}

function authorized(req) {
  const url = new URL(req.url, "http://x");
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  // Two credential forms are accepted: "Authorization: Bearer <token>", or
  // the token as the path segment after /mcp/ (some hosted MCP clients can
  // only be given a URL, not custom headers).
  const candidates = [bearer, url.pathname.split("/")[2] || ""];
  return candidates.some(
    (c) => c.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(TOKEN))
  );
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const log = `${new Date().toISOString()} ${req.method} ${url.pathname.split("/")[1] || "/"}`;
    if (!url.pathname.startsWith("/mcp") || !authorized(req)) {
      console.log(log, "401");
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    let tooLarge = false;
    for await (const chunk of req) {
      if (tooLarge) continue;
      body += chunk;
      if (body.length > 1e6) tooLarge = true;
    }
    if (tooLarge) {
      res.writeHead(413).end();
      return;
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const out = Array.isArray(msg)
      ? (await Promise.all(msg.map(handle))).filter(Boolean)
      : await handle(msg);
    console.log(log, Array.isArray(msg) ? "batch" : msg.method);
    if (!out || (Array.isArray(out) && !out.length)) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log("notion-mcp-windows is running");
    console.log(`  URL (local):  http://127.0.0.1:${PORT}/mcp/<token>`);
    console.log(`  Config file:  ${existsSync(CONFIG_PATH) ? CONFIG_PATH : "(none — defaults/env only)"}`);
    console.log(`  Working dir:  ${ROOT}`);
    console.log(`  Token file:   ${TOKEN_FILE} (contents never printed)`);
    console.log(`  Audit log:    ${AUDIT}`);
    if (process.platform !== "win32") {
      console.log("  Warning:      not running on Windows — run_command is disabled.");
    }
    console.log("Stop with Ctrl+C. Do not expose this port directly — see README.");
  });
