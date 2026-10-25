/* DSH Chrome Bridge — Native Messaging host.
 *
 * Installed by the dsh-chrome-control plugin: every time dsh boots with the
 * plugin, `src/native-host.ts` copies this file to `$DSH_HOME/native-host/`,
 * writes a launcher next to it, and registers `com.dsh.chrome` with each
 * Chromium-family browser present. Nobody runs an installer by hand.
 *
 * It serves exactly the things the store extension cannot do itself:
 *
 *   - `start`     — launch `dsh web` when it is not running;
 *   - `restart`   — stop the `dsh web` listening on the extension's port and
 *                   launch a fresh one (the settings page's "Restart server",
 *                   mirroring the Mac app's ServerTermination + relaunch);
 *   - `cookie`    — sign the browser-session login cookie with the secret in
 *                   `$DSH_HOME/.credentials.yaml` (the secret never leaves here);
 *   - `filePaths` — the absolute paths of the files/folders on the macOS
 *                   general (copy) or drag pasteboard, or on the Windows /
 *                   Linux clipboard (copy only: neither keeps a drag
 *                   pasteboard; Linux reads text/uri-list via wl-paste/xclip).
 *                   Browsers never expose a pasted or dropped item's real path,
 *                   so a folder can only be referenced by path through here
 *                   (read-only);
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
import { execFile, spawn } from "node:child_process";
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
  if (process.platform === "win32") {
    // npm/pnpm 在 Windows 上装的是 dsh.cmd 垫片;spawn 它要走 cmd(见 spawnSpec)。
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const candidates = [
      pnpmHome && path.join(pnpmHome, "dsh.cmd"),
      path.join(localAppData, "pnpm", "dsh.cmd"),
      path.join(appData, "npm", "dsh.cmd"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "nodejs", "dsh.cmd"),
      path.join(home, ".cargo", "bin", "dsh.exe"),
    ];
    for (const c of candidates) if (c && fs.existsSync(c)) return c;
    return "dsh";
  }
  const candidates = [
    pnpmHome && path.join(pnpmHome, "dsh"),
    path.join(home, "Library/pnpm/bin/dsh"),
    path.join(home, "Library/pnpm/dsh"),
    path.join(home, ".local/share/pnpm/bin/dsh"),
    path.join(home, ".local/share/pnpm/dsh"),
    path.join(home, ".npm-global/bin/dsh"),
    path.join(home, ".volta/bin/dsh"),
    "/opt/homebrew/bin/dsh",
    "/home/linuxbrew/.linuxbrew/bin/dsh",
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
/// 写一帧,等它真正交给系统再返回:Windows 上管道的 stdout 是异步写,只靠
/// 退出前的 sleep 不能保证帧已离开进程。
function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return new Promise((resolve) => process.stdout.write(Buffer.concat([header, json]), () => resolve()));
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

/**
 * spawn 的参数。Windows 上 .cmd/.bat 垫片(以及只剩裸名 "dsh" 时的 PATH 查找)
 * 不能直接 CreateProcess —— Node 自 CVE-2024-27980 起会直接报 EINVAL —— 只能经
 * cmd 解释,于是命令行由这里自己拼:路径整体加引号,其余参数都是本文件生成的
 * 固定串(host 已核过是环回、port 已核过是整数),没有可注入的东西。
 * windowsHide:不让 dsh web 弹出一个控制台窗口。
 */
function spawnSpec(command, args) {
  const options = { windowsHide: true };
  if (process.platform === "win32" && (/\.(cmd|bat)$/i.test(command) || !path.isAbsolute(command))) {
    const quote = (value) => (/[\s"&|<>^()]/.test(value) ? `"${value}"` : value);
    return { command: [command, ...args].map(quote).join(" "), args: [], options: { ...options, shell: true } };
  }
  return { command, args, options };
}

/** 扩展传来的 host/port 核过才用:只在环回上、只用合法端口。不合法时回失败回包。 */
function webTarget(opts) {
  const host = opts.host || "127.0.0.1";
  const port = Number(opts.port) || 3080;
  if (!LOOPBACK_HOSTS.has(String(host).toLowerCase())) return { error: { ok: false, reason: "host-not-loopback", host, port } };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: { ok: false, reason: "bad-port", host, port } };
  return { host, port };
}

async function startWeb(opts) {
  const target = webTarget(opts);
  if (target.error) return target.error;
  const { host, port } = target;
  if (await probePort(port, host, 800)) return { ok: true, alreadyUp: true, host, port };
  return await launchWeb(host, port);
}

/** 起一个新的 dsh web 并等端口就绪。不先探活 —— 调用方已经确认端口空着。 */
async function launchWeb(host, port) {
  const launch = resolveLaunch();
  const logPath = path.join(logDir(), "dsh-web.log");
  let logFd = null;
  try { logFd = fs.openSync(logPath, "a"); } catch {}
  const out = logFd != null ? logFd : "ignore";
  const err = logFd != null ? logFd : "ignore";
  const spec = spawnSpec(launch.command, [...launch.args, "web", "--no-open", "--host", String(host), "--port", String(port)]);
  const child = spawn(spec.command, spec.args, {
    ...spec.options,
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

/** SIGTERM 之后给 dsh web 收尾(关会话、带走工具子进程)的时间,超时再 SIGKILL。与 Mac 一致。 */
const STOP_GRACE_MS = 5000;
const FORCED_EXIT_WAIT_MS = 2000;

/** 跑一个只读的系统命令,拿 stdout;失败(含命令不存在)回 null。 */
function capture(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      // lsof 查不到监听者时退出码是 1 且 stdout 为空 —— 那是"没有",不是"失败"。
      if (error && !String(stdout || "").trim()) return resolve(error.code === 1 ? "" : null);
      resolve(String(stdout || ""));
    });
  });
}

/** 系统工具常在 /usr/sbin(macOS 的 lsof),Chrome 给宿主的 PATH 未必带它。 */
function findSystemTool(name) {
  return findExecutable(name) ?? ["/usr/sbin", "/sbin"].map((dir) => path.join(dir, name)).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  }) ?? null;
}

/**
 * 监听这个 TCP 端口的 pid,没有就 null。
 *
 * 按端口查而不是记 pid:要重启的那个 dsh web 多半不是本宿主起的(用户在终端里
 * 起的、Mac App 起的、或上一次重启起的 —— 宿主每次请求都是新进程,什么也记不住)。
 * 不按绑定地址过滤,理由同 Mac 的 ServerTermination:绑在 *:port 的也得找得到。
 * Linux 上没有 lsof 时退回 ss。
 */
async function listeningPid(port) {
  const lsof = findSystemTool("lsof");
  if (lsof) {
    const out = await capture(lsof, ["-nP", "-t", "-sTCP:LISTEN", `-iTCP:${port}`]);
    if (out !== null) {
      const pid = out.split(/\s+/).map(Number).find((value) => Number.isInteger(value) && value > 0);
      return pid ?? null;
    }
  }
  const ss = findSystemTool("ss");
  if (ss) {
    const out = await capture(ss, ["-Hltnp", `sport = :${port}`]);
    const match = out && /pid=(\d+)/.exec(out);
    if (match) return Number(match[1]);
  }
  return null;
}

/** 进程的完整命令行;拿不到回 null。 */
async function commandLineOf(pid) {
  const out = await capture(findSystemTool("ps") ?? "/bin/ps", ["-o", "command=", "-p", String(pid)]);
  const line = out?.trim();
  return line || null;
}

/**
 * 端口上的是不是 dsh web。重启会 kill 这个进程,所以只认命令行里同时有 dsh
 * 与 web 子命令的那一个 —— 端口来自扩展设置,被别的程序占着时宁可报错也不能误杀。
 * resolveLaunch 的入口(DSH_BIN / 记下的 dsh 入口)也算 dsh:改过名的安装照样认得。
 */
function looksLikeDshWeb(commandLine, launch = resolveLaunch()) {
  const line = String(commandLine || "");
  if (!/(^|\s)web(\s|$)/.test(line)) return false;
  if (/(^|[\s/\\])dsh(\.(c?js|mjs|cmd|exe))?(\s|$)/i.test(line) || /@deepseek-ai[\\/]dsh[\\/]/.test(line)) return true;
  return [launch.command, ...launch.args].some((part) => part && part !== "dsh" && path.isAbsolute(part) && line.includes(part));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function waitForExit(pid, port, host, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid) && !(await probePort(port, host, 300))) return true;
    await sleep(100);
  }
  return !isAlive(pid) && !(await probePort(port, host, 300));
}

/**
 * 重启 dsh web:停掉端口上的那个,再在同一地址起一个新的。
 *
 * 先礼后兵:SIGTERM 让 dsh 正常收尾(它把 SIGTERM 当普通停止,会带走自己起的
 * 工具子进程),5s 不走再 SIGKILL,并确认它真的没了才去绑端口。
 * 端口本来就空着(服务已经挂了)时直接起一个 —— 用户按"重启"要的是一个新服务。
 *
 * Windows 暂不支持:找监听进程与核对命令行都要另一套工具,先如实回不支持,
 * 扩展会退回 chrome-daemon 的重启。
 */
async function restartWeb(opts) {
  const target = webTarget(opts);
  if (target.error) return target.error;
  const { host, port } = target;
  if (process.platform === "win32") return { ok: false, reason: "unsupported-platform", host, port };
  const previousPid = await listeningPid(port);
  let stopped = false;
  if (previousPid) {
    const commandLine = await commandLineOf(previousPid);
    if (!looksLikeDshWeb(commandLine)) {
      return { ok: false, reason: "not-dsh-web", host, port, pid: previousPid };
    }
    process.kill(previousPid, "SIGTERM");
    stopped = await waitForExit(previousPid, port, host, STOP_GRACE_MS);
    if (!stopped) {
      try { process.kill(previousPid, "SIGKILL"); } catch {}
      stopped = await waitForExit(previousPid, port, host, FORCED_EXIT_WAIT_MS);
    }
    if (!stopped) return { ok: false, reason: "still-running", host, port, pid: previousPid };
  } else if (await probePort(port, host, 800)) {
    // 端口通着却查不到是谁(没有 lsof/ss,或权限不够):不知道要停谁,就不动它。
    return { ok: false, reason: "listener-unknown", host, port };
  }
  const started = await launchWeb(host, port);
  return { ...started, stopped, previousPid: previousPid ?? null };
}

async function status() {
  const launch = resolveLaunch();
  const found = launch.args.length > 0 || fs.existsSync(launch.command);
  return {
    ok: true,
    host: HOST_NAME,
    version: "2.2.0",
    // 扩展据此决定"重启"走本宿主还是退回 chrome-daemon;老宿主没有这个字段。
    commands: ["start", "restart", "status", "cookie", "filePaths"],
    dsh: found ? [launch.command, ...launch.args].join(" ") : null,
    logDir: logDir(),
  };
}

/**
 * 剪贴板/拖拽板 → 系统 NSPasteboard 名。只认这两块:扩展粘贴读 general,
 * 拖放读 drag(macOS 在拖拽开始时写入,松手后保留到下一次拖拽)。
 */
const PASTEBOARDS = Object.freeze({ general: "NSPasteboardNameGeneral", drag: "NSPasteboardNameDrag" });

/** 只留绝对路径:pasteboard 上不该有相对路径,有也不能当真。 */
function absolutePaths(paths) {
  return Array.isArray(paths) ? paths.filter((p) => typeof p === "string" && path.isAbsolute(p)) : [];
}

/**
 * Windows 剪贴板(CF_HDROP)上的文件/文件夹路径。用系统自带的 Windows PowerShell
 * 调 System.Windows.Forms.Clipboard(要 STA),不引入原生依赖。脚本走
 * -EncodedCommand,免得 cmd/PowerShell 两层引号;结果是 UTF-8 JSON 再转 base64 ——
 * 输出只剩 ASCII,非 ASCII 路径(中文用户名、中文文件夹)就不会被 OEM 代码页
 * 弄坏,也不必去改控制台编码(宿主没有可见控制台时那一步本身可能失败)。
 * Windows 没有像 macOS 那样会保留下来的拖拽板,所以 drag 如实回不支持。
 */
function windowsClipboardFilePaths(board) {
  if (board !== "general") return Promise.resolve({ ok: false, reason: "unsupported-board" });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$list = @([System.Windows.Forms.Clipboard]::GetFileDropList())",
    "$json = ConvertTo-Json -Compress -InputObject $list",
    "[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const powershell = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
      { timeout: 10000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        if (error) return resolve({ ok: false, reason: "pasteboard-read-failed" });
        try {
          const json = Buffer.from(String(stdout).trim(), "base64").toString("utf8");
          const parsed = JSON.parse(json || "[]");
          resolve({ ok: true, paths: absolutePaths(Array.isArray(parsed) ? parsed : [parsed]) });
        } catch {
          resolve({ ok: false, reason: "pasteboard-read-failed" });
        }
      });
  });
}

/** PATH(Chrome 继承自桌面会话)里加上常见系统目录,找一个可执行文件;没有就 null。 */
function findExecutable(name) {
  const dirs = [...String(process.env.PATH || "").split(path.delimiter), "/usr/bin", "/usr/local/bin", "/bin"];
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  return null;
}

/**
 * text/uri-list(RFC 2483)→ 绝对路径。只认 file: URI;注释行(#)、空行、
 * 别的 scheme 与带远端主机的 file URI 一律跳过。
 */
function parseUriList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const uri = line.trim();
    if (!uri || uri.startsWith("#") || !/^file:/i.test(uri)) continue;
    try { out.push(fileURLToPath(uri)); } catch {}
  }
  return absolutePaths(out);
}

/**
 * Linux 剪贴板上的文件/文件夹路径。文件管理器(Nautilus、Dolphin、Thunar…)复制
 * 文件时都会提供 text/uri-list,这里按会话类型找系统自带的剪贴板工具去读:
 * Wayland 用 wl-paste(wl-clipboard),X11 用 xclip;XWayland 下两者都试。
 * 剪贴板里没有这种类型(复制的是文字)= 没有路径,回空列表而不是失败。
 * Linux 也没有会保留下来的拖拽板,所以 drag 如实回不支持。
 */
function linuxClipboardFilePaths(board) {
  if (board !== "general") return Promise.resolve({ ok: false, reason: "unsupported-board" });
  const tools = [];
  if (process.env.WAYLAND_DISPLAY) tools.push({ name: "wl-paste", args: ["--no-newline", "--type", "text/uri-list"] });
  if (process.env.DISPLAY) tools.push({ name: "xclip", args: ["-selection", "clipboard", "-o", "-t", "text/uri-list"] });
  if (tools.length === 0) return Promise.resolve({ ok: false, reason: "no-display" });
  // 「这块剪贴板里没有 uri-list / 是空的」的各家说法:不是错误,只是没有路径。
  const EMPTY = /no suitable type|not available|nothing is copied|no selection|target .* not available/i;
  const attempt = (index, missing) => new Promise((resolve) => {
    if (index >= tools.length) return resolve({ ok: false, reason: missing ? "clipboard-tool-missing" : "pasteboard-read-failed" });
    const tool = tools[index];
    const file = findExecutable(tool.name);
    if (!file) return resolve(attempt(index + 1, missing));
    execFile(file, tool.args, { timeout: 5000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, paths: parseUriList(stdout) });
      if (EMPTY.test(String(stderr))) return resolve({ ok: true, paths: [] });
      resolve(attempt(index + 1, false));
    });
  });
  return attempt(0, true);
}

/**
 * 读某块 pasteboard 上的文件 URL,返回绝对路径。只读,不改 pasteboard。
 * macOS 用系统自带的 osascript(JXA)调 AppKit,Windows、Linux 见上;都不引入原生依赖。
 */
function pasteboardFilePaths(board) {
  if (!Object.hasOwn(PASTEBOARDS, board)) return Promise.resolve({ ok: false, reason: "bad-board" });
  if (process.platform === "win32") return windowsClipboardFilePaths(board);
  if (process.platform === "linux") return linuxClipboardFilePaths(board);
  if (process.platform !== "darwin") return Promise.resolve({ ok: false, reason: "unsupported-platform" });
  const script = [
    "ObjC.import('AppKit');",
    `var pb = $.NSPasteboard.pasteboardWithName($.${PASTEBOARDS[board]});`,
    "var urls = pb.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));",
    "var out = [];",
    "if (urls) for (var i = 0; i < urls.count; i++) out.push(ObjC.unwrap(urls.objectAtIndex(i).path));",
    "JSON.stringify(out);",
  ].join("\n");
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve({ ok: false, reason: "pasteboard-read-failed" });
      try {
        const paths = JSON.parse(String(stdout).trim());
        resolve({ ok: true, paths: absolutePaths(paths) });
      } catch {
        resolve({ ok: false, reason: "pasteboard-read-failed" });
      }
    });
  });
}

async function dispatch(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, reason: "bad-message" };
  switch (msg.cmd) {
    case "start":
      if (msg.target === "web") return await startWeb(msg);
      return { ok: false, reason: "unknown-target" };
    case "restart":
      if (msg.target === "web") return await restartWeb(msg);
      return { ok: false, reason: "unknown-target" };
    case "status": return await status();
    case "cookie": return signBrowserSession(msg.host, Number(msg.port));
    case "filePaths": return await pasteboardFilePaths(msg.board);
    default: return { ok: false, reason: "unknown-cmd" };
  }
}

// 调用方不对:不读帧、不碰密钥、不拉进程,只回一条结构化拒绝就退出。放在
// readMessage 之前,是为了让被拒的调用方连解析路径都走不到。
if (!callerAllowed(process.argv.slice(2))) {
  await writeMessage({ ok: false, reason: "caller-not-allowed" });
  await sleep(50);
  process.exit(0);
}

const msg = await readMessage();
if (msg === MALFORMED_FRAME) {
  await writeMessage({ ok: false, reason: "bad-message" });
  await sleep(50);
  process.exit(0);
}
if (msg != null) {
  let result;
  try { result = await dispatch(msg); }
  catch (e) { result = { ok: false, reason: String((e && e.message) || e) }; }
  await writeMessage(result);
  await sleep(50);
  process.exit(0);
}
