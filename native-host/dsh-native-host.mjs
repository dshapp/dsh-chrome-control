/* DSH Chrome Bridge — Native Messaging host.
 *
 * Installed by the dsh-chrome-control plugin: every time dsh boots with the
 * plugin, `src/native-host.ts` copies this file to `$DSH_HOME/native-host/`,
 * writes a launcher next to it, and registers `com.dsh.chrome` with each
 * Chromium-family browser present. Nobody runs an installer by hand.
 *
 * It serves exactly the two things the store extension cannot do itself:
 *
 *   - `start`  — launch `dsh web` when it is not running;
 *   - `cookie` — sign the browser-session login cookie with the secret in
 *                `$DSH_HOME/.credentials.yaml` (the secret never leaves here);
 *
 * plus a read-only `status` probe for the extension's settings page.
 *
 * One request per process: Chrome writes one message (4-byte LE length +
 * JSON) on stdin, this writes one reply and exits. A started server is
 * spawned detached and unref'd, because Native Messaging kills the host the
 * moment the reply is flushed.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.dsh.chrome";

/**
 * 唯一允许调用本宿主的扩展(Chrome 应用商店 "Deepseek Harness APP" 的 id)。
 *
 * 这是第二道闸。第一道是宿主清单里的 allowed_origins,由 Chrome 自己执行;但清单
 * 只是用户目录下一个可写的 JSON,多装一个 Chromium 系浏览器、手改一次、或者用
 * DSH_EXTENSION_ID 装错一次,都会把别的扩展放进来。而本宿主能拉起进程、能用
 * ~/.dsh 里的密钥签登录 cookie,所以自己再核一次调用方。
 *
 * 调用方从哪来:Chrome 启动宿主时把调用方 origin 作为**第一个命令行参数**传进来
 * (Windows 上还会多一个 --parent-window=…)。这个值由浏览器填写,扩展改不了;
 * 所以 launcher 包装脚本必须用 "$@" 把参数原样转给 node,否则这里一律拒绝。
 *
 * 测试断言它与 daemon/src/host_guard.rs 的 ALLOWED_ORIGIN 一致,两处不会各自漂移。
 */
const ALLOWED_EXTENSION_ID = "kgjjicancjnedmappjhefngdjaommpop";

/**
 * 核对 Chrome 传入的调用方。只看第一个参数,并且整串精确比较:用前缀或
 * includes 匹配会放过 "chrome-extension://<id>x/" 这类值。尾部斜杠 Chrome 总会带,
 * 这里两种写法都认,别的一概不认。
 */
function callerAllowed(argv) {
  const origin = argv[0];
  if (typeof origin !== "string") return false;
  const expected = `chrome-extension://${ALLOWED_EXTENSION_ID}`;
  return origin === expected + "/" || origin === expected;
}
const COOKIE_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;
const COOKIE_RECORD = "client-connection/browser-session";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function browserSessionSecret() {
  const file = path.join(dshHome(), ".credentials.yaml");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const record = lines.findIndex((line) => line.trimStart().startsWith(`${COOKIE_RECORD}:`));
  if (record < 0) throw new Error(`${file}: record ${COOKIE_RECORD} not found`);
  const indent = lines[record].length - lines[record].trimStart().length;
  let version = null;
  let encoded = null;
  for (const line of lines.slice(record + 1)) {
    if (!line.trim()) continue;
    const currentIndent = line.length - line.trimStart().length;
    if (currentIndent <= indent) break;
    const trimmed = line.trim();
    if (trimmed.startsWith("version:")) version = trimmed.slice(8).trim().replace(/^['\"]|['\"]$/g, "");
    if (trimmed.startsWith("secret:")) encoded = trimmed.slice(7).trim().replace(/^['\"]|['\"]$/g, "");
  }
  if (version !== "1") throw new Error(`${file}: unsupported browser-session payload version`);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error(`${file}: invalid browser-session secret`);
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length !== 32) throw new Error(`${file}: browser-session secret must be 32 bytes`);
  return secret;
}

function signBrowserSession(host = "127.0.0.1", port = 3080, now = Date.now()) {
  const authority = `${host}:${port}`;
  if (authority !== "127.0.0.1:3080") throw new Error("DSH 0.1.2 requires authority 127.0.0.1:3080");
  const issuedAt = Math.trunc(now);
  const expiresAt = issuedAt + COOKIE_MAX_AGE_MS;
  const payload = JSON.stringify({ version: 1, authority, issuedAt, expiresAt });
  const body = base64url(payload);
  const signature = crypto.createHmac("sha256", browserSessionSecret()).update(body).digest("base64url");
  return {
    ok: true,
    name: "dsh-auth-" + crypto.createHash("sha256").update(authority).digest("base64url"),
    value: `v1.${body}.${signature}`,
    expirationDate: expiresAt / 1000
  };
}

/**
 * 插件在 dsh 启动时落盘的配置:**正在运行的那个 dsh** 是用哪个 node、哪个入口
 * 起来的。这是唯一不用猜的来源 —— 一台机器可能并存 npm -g / pnpm / Homebrew
 * 多份 dsh,而插件装在哪份的 profile 里,只有跑起来的那份自己知道。
 * 读失败一律返回 null 并回退到候选列表:配置损坏不能让 status 都不通。
 */
function readInstallConfig() {
  try {
    const raw = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json"), "utf8");
    const config = JSON.parse(raw);
    return config && typeof config === "object" ? config : null;
  } catch {
    return null;
  }
}

/**
 * 怎么把 dsh 跑起来:`{ command, args }`,args 之后再接 `web …`。
 *
 * 顺序:显式 DSH_BIN > 插件记下的 node + 入口(上次真正在跑的那份)> 常见安装位置。
 * 挑错的后果很隐蔽 —— server 照常起、端口照常通,只是跑着另一份 dsh、找不到
 * 这个插件,看起来像"装了没生效"。所以落盘记录排在猜测前面;记录里的路径若已
 * 不存在(比如 pnpm 重装换了内容哈希目录、还没再启动过 dsh),才退回去猜。
 */
function resolveLaunch() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return { command: process.env.DSH_BIN, args: [] };
  const config = readInstallConfig();
  if (typeof config?.node === "string" && typeof config?.dshEntry === "string"
      && fs.existsSync(config.node) && fs.existsSync(config.dshEntry)) {
    return { command: config.node, args: [config.dshEntry] };
  }
  return { command: resolveDsh(), args: [] };
}

function resolveDsh() {
  const home = os.homedir();
  const pnpmHome = process.env.PNPM_HOME;
  const candidates = [
    pnpmHome && path.join(pnpmHome, "dsh"),
    path.join(home, "Library/pnpm/bin/dsh"),
    path.join(home, "Library/pnpm/dsh"),
    path.join(home, ".local/share/pnpm/bin/dsh"),
    path.join(home, ".local/share/pnpm/dsh"),
    "/opt/homebrew/bin/dsh",
    path.join(home, ".cargo/bin/dsh"),
    path.join(home, ".local/bin/dsh"),
    "/usr/local/bin/dsh",
    "/usr/bin/dsh",
    "dsh",
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return "dsh";
}
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function logDir() {
  const dir = path.join(dshHome(), "logs", "chrome-native-host");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/// 帧体不是合法 JSON 时的哨兵。坏帧也要回一条结构化错误 —— 直接在 data 监听器
/// 里 JSON.parse 抛异常会把宿主进程带走(exit 1、stdout 0 字节),Chrome 只看到
/// "native host 退出且没有回包",dispatch 里那条 bad-message 分支永远走不到。
const MALFORMED_FRAME = Symbol("malformed-frame");

function readMessage() {
  return new Promise((resolve) => {
    let header = Buffer.alloc(0);
    let body = Buffer.alloc(0);
    let bodyLen = 0;
    let gotLen = false;
    const finish = (buf) => {
      process.stdin.removeListener("data", onData);
      try {
        resolve(JSON.parse(buf.subarray(0, bodyLen).toString("utf8")));
      } catch {
        resolve(MALFORMED_FRAME);
      }
    };
    const onData = (chunk) => {
      if (!gotLen) {
        header = Buffer.concat([header, chunk]);
        if (header.length >= 4) {
          bodyLen = header.readUInt32LE(0);
          const rest = header.subarray(4);
          header = Buffer.alloc(0);
          gotLen = true;
          if (rest.length) {
            body = Buffer.concat([body, rest]);
            if (body.length >= bodyLen) finish(body);
          }
        }
      } else {
        body = Buffer.concat([body, chunk]);
        if (body.length >= bodyLen) finish(body);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", () => resolve(null));
  });
}
function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function probePort(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}
async function waitForPort(port, host, budgetMs) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await probePort(port, host, 800)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只替扩展在环回上起 server:host 来自扩展设置,不能借它把 dsh 绑到网卡上。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

async function startWeb(opts) {
  const host = opts.host || "127.0.0.1";
  const port = Number(opts.port) || 3080;
  if (!LOOPBACK_HOSTS.has(String(host).toLowerCase())) return { ok: false, reason: "host-not-loopback", host, port };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "bad-port", host, port };
  if (await probePort(port, host, 800)) return { ok: true, alreadyUp: true, host, port };
  const launch = resolveLaunch();
  const logPath = path.join(logDir(), "dsh-web.log");
  let logFd = null;
  try { logFd = fs.openSync(logPath, "a"); } catch {}
  const out = logFd != null ? logFd : "ignore";
  const err = logFd != null ? logFd : "ignore";
  const child = spawn(launch.command, [...launch.args, "web", "--no-open", "--host", String(host), "--port", String(port)], {
    detached: true,
    stdio: ["ignore", out, err],
    cwd: os.homedir(),
    env: { ...process.env },
  });
  child.unref();
  try { child.on("error", () => {}); } catch {}
  const pid = child.pid ?? null;
  const up = await waitForPort(port, host, 20000);
  return up
    ? { ok: true, pid, host, port, log: logPath }
    : { ok: false, pid, host, port, log: logPath, reason: "port-stayed-down" };
}

async function status() {
  const launch = resolveLaunch();
  const found = launch.args.length > 0 || fs.existsSync(launch.command);
  return {
    ok: true,
    host: HOST_NAME,
    version: "2.0.0",
    dsh: found ? [launch.command, ...launch.args].join(" ") : null,
    logDir: logDir(),
  };
}

async function dispatch(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, reason: "bad-message" };
  switch (msg.cmd) {
    case "start":
      if (msg.target === "web") return await startWeb(msg);
      return { ok: false, reason: "unknown-target" };
    case "status": return await status();
    case "cookie": return signBrowserSession(msg.host, Number(msg.port));
    default: return { ok: false, reason: "unknown-cmd" };
  }
}

// 调用方不对:不读帧、不碰密钥、不拉进程,只回一条结构化拒绝就退出。放在
// readMessage 之前,是为了让被拒的调用方连解析路径都走不到。
if (!callerAllowed(process.argv.slice(2))) {
  writeMessage({ ok: false, reason: "caller-not-allowed" });
  await sleep(50);
  process.exit(0);
}

const msg = await readMessage();
if (msg === MALFORMED_FRAME) {
  writeMessage({ ok: false, reason: "bad-message" });
  await sleep(50);
  process.exit(0);
}
if (msg != null) {
  let result;
  try { result = await dispatch(msg); }
  catch (e) { result = { ok: false, reason: String((e && e.message) || e) }; }
  writeMessage(result);
  await sleep(50);
  process.exit(0);
}
