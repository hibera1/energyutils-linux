import { app, BrowserWindow, ipcMain, shell, dialog, clipboard } from "electron";
import { promises as fs, existsSync, mkdirSync, readdirSync, createWriteStream, rmSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { detectAnalysisTools, gateSummary, startWatchdog, stopWatchdog } from "./antiAnalysisShim.mjs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import os from "node:os";
import { createRequire } from "node:module";
import { delimiter } from "node:path";
import { extractArchive, hideFile, liftJreDir, makeExecutable, stripJre as xplatStripJre } from "./xplat.js";

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

// ---- Нативный модуль защиты (ключи внутри C++). На Linux собирается отдельно (CI). ----
const __require = createRequire(import.meta.url);
let _euNative = null;
try {
  const nativePath = join(__dirname, "..", "assets", "native", "eu_native.node");
  if (process.platform === "win32") {
    _euNative = __require(nativePath);
  } else {
    // Linux: грузим только если модуль собран под нашу ABI (иначе null — без ключа не расшифровать).
    try { _euNative = __require(nativePath); } catch { _euNative = null; }
  }
} catch { _euNative = null; }
const euDecode = (buf) => { try { return _euNative ? _euNative.decodeMod(buf) : null; } catch { return null; } };
const euEncode = (buf) => { try { return _euNative ? _euNative.encodeMod(buf) : null; } catch { return null; } };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Папка лаунчера (рядом с exe). Для portable-сборки process.execPath указывает
// на распакованный в %TEMP% рантайм, поэтому реальный exe берём из env-переменной.
const APP_DIR = dirname(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
// «Встроенный майн»: если рядом с лаунчером лежит папка game/ (minecraft.jar + libs + mods),
// играем оттуда — лаунчер уже самодостаточен и в его папке. Иначе фолбэк: C:/EnergyUtils/game.
const LOCAL_GAME_DIR = join(APP_DIR, "game");
// Linux/macOS -> ~/.energyutils (XDG_DATA_HOME если задан), Windows -> C:/EnergyUtils.
const DATA_HOME = process.platform === "win32"
  ? "C:/EnergyUtils"
  : (process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "energyutils") : join(os.homedir(), ".energyutils"));
const DATA_GAME_DIR = join(DATA_HOME, "game");
const DATA_CONFIG_DIR = join(DATA_HOME, "configs");
const GAME_DIR = existsSync(LOCAL_GAME_DIR) ? LOCAL_GAME_DIR : DATA_GAME_DIR;
const LIBS_DIR = join(GAME_DIR, "libs");
const MODS_DIR = join(GAME_DIR, "mods");
const LOCAL_CONFIG_DIR = join(APP_DIR, "configs");
const CONFIG_DIR = existsSync(LOCAL_CONFIG_DIR) ? LOCAL_CONFIG_DIR : DATA_CONFIG_DIR;
const ALTS_PATH = join(CONFIG_DIR, "alts.txt");
const ALTS_META_PATH = join(CONFIG_DIR, "alts_meta.json");
const SETTINGS_PATH = join(app.getPath("userData"), "settings.json");
let LOGS_DIR = join(GAME_DIR, "logs");
const CRASH_DIR = join(GAME_DIR, "crash-reports");

// Единый источник мода: energyutils.fun → downloads/. Всё, что лаунчер должен
// скачивать, лежит на сайте в папке downloads/: мод (version.json + части) и
// сам лаунчер (launcher/version.json + EnergyUtils.exe).
const UPDATE_BASE = "https://energyutils.fun";
const UPDATE_DIR = UPDATE_BASE + "/downloads";
const LAUNCHER_UPDATE_DIR = UPDATE_DIR + "/launcher";
// ── GitHub Releases (быстрый CDN, без обрезов Cloudflare-зоны) ──
// Мод + клиент + fabric-api из hibera1/minecraft.
const GH_OWNER = "hibera1";
const GH_MC = `https://github.com/${GH_OWNER}/minecraft/releases/download/v1.21.4`;
const GH_MOD_JAR = `${GH_MC}/EnergyUtils.jar.enc`;
const GH_CLIENT_ZIP = `${GH_MC}/minecraft-1.21.4.zip`;
const GH_FABRIC_API = `${GH_MC}/fabric-api.jar`;
const GH_JRE_LINUX = `${GH_MC}/jre21-linux.tar.gz`;
const SEED_JAR = join(app.getPath("home"), "Downloads", "EnergyUtils.jar");
// Файл мода лежит в mods под нейтральным «модовым» именем — сам mod id внутри
// fabric.mod.json от имени файла не зависит, поэтому ничего ломается.
const MOD_FILE_NAME = "EnergyUtils.jar";
const MOD_JAR = join(MODS_DIR, MOD_FILE_NAME);
// Мод на диске хранится ВСЕГДА зашифрованным (.enc). Чистый jar появляется
// только на время запуска игры прямо в mods (KnotClient игнорирует --modsDir,
// моды грузятся исключительно из gameDir/mods) и удаляется после выхода.
const MOD_JAR_ENC = join(MODS_DIR, "EnergyUtils.jar.enc");
const MOD_MANIFEST = join(MODS_DIR, "manifest.json");

// JS-фолбэк расшифровки мода (для Linux-сборки, где нет нативного eu_native.node).
// Ключ НЕ лежит в открытом виде: хранится XOR-замаскированным байт-массивом и
// раскрывается только в рантайме функции. Используется когда нативка недоступна.
const MOD_ENC_KEY_MASKED = Buffer.from([0xDF,0x95,0x6F,0x3B,0xF2,0x44,0xAD,0x98,0x56,0x8B,0x0C,0xD4,0xBC,0x35,0x40,0xC3,0xE7,0x2D,0xBA,0x1E,0x96,0x59,0xFC,0xA2,0x07,0x49,0xEB,0x70,0xCE,0x25,0xB3,0x67]);
function jsDecodeMod(data) {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ (MOD_ENC_KEY_MASKED[i & 31] ^ 0xA5);
  return out;
}

// Расшифровать .enc → чистый jar. Нативка приоритетна, иначе JS-фолбэк.
function decodeModAny(data) {
  try { const r = euDecode(data); if (r) return r; } catch {}
  try { return jsDecodeMod(data); } catch {}
  return null;
}

// ── Кастомная Java 21: на Windows JRE вшита в exe (assets/java/jre21.zip);
// на Linux качается с GitHub (jre21-linux.tar.gz) при первом запуске.
// Игра и Fabric стартуют ТОЛЬКО на этой JVM. Флаги запрещают attach-механизмы.
const JAVA_DIR = join(GAME_DIR, process.platform === "win32" ? "java" : "HBJVM-L");
const JAVA_EXE = join(JAVA_DIR, "bin", process.platform === "win32" ? "java.exe" : "java");
const JAVA_ZIP_ASSET = join(__dirname, "..", "assets", "java", process.platform === "win32" ? "jre21.zip" : "HBJVM-L-linux.zip");
const JAVA_ZIP_SHA256 = "d35f31e712f0fcf6ac5a093edc90204fbff22f720ba3950bd09d331d5e621636";
const JAVA_MARKER = join(JAVA_DIR, "energyutils-java-ok");

// Жёсткие флаги: без javaagent/instrumentation, без attach (dump памяти невозможен
// через jmap/VisualVM), без JDWP-порта, без perf-данных, OOM — мгновенный выход.
// Java 21: динамические агенты (agentlib/agentpath/attach) запрещены отдельно.
const JAVA_HARDENED_FLAGS = [
  "-XX:+DisableAttachMechanism",     // запрет attach-агентов и инструментов
  "-XX:-EnableDynamicAgentLoading",  // Java 21: динамические агенты не грузятся
  "-XX:-UsePerfData",                // не создавать hsperfdata (нет утечки метаданных)
  "-XX:+ExitOnOutOfMemoryError",     // OOM = аварийный выход, без зависания
  "-XX:+UnlockDiagnosticVMOptions",
  "-XX:-ManagementServer",           // нет JMX-порта, нечем подключаться
  "-Dfile.encoding=UTF-8",
];

// Урезаем JRE от инструментов, которыми можно снять дамп/запустить сервисы:
// jfr/jrunscript/jwebserver/rmiregistry/keytool и т. п. не нужны клиенту,
// а шанс использовать их против нас — убираем.
const JRE_STRIP = [
  "jfr.exe", "jrunscript.exe", "jwebserver.exe", "rmiregistry.exe",
  "keytool.exe", "kinit.exe", "klist.exe", "ktab.exe",
];
async function stripJre() {
  try {
    if (!existsSync(JAVA_DIR)) return;
    const bin = join(JAVA_DIR, "bin");
    for (const f of JRE_STRIP) {
      try { const p = join(bin, f); if (existsSync(p)) await fs.rm(p, { force: true }); } catch {}
    }
    // Удаляем jfr конфиги и ненужные legal/доки (шум + поверхность атаки).
    for (const rel of ["lib\\jfr", "legal", "conf\\management"]) {
      try { const p = join(JAVA_DIR, rel); if (existsSync(p)) await fs.rm(p, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

async function ensureBundledJava() {
  // 1) Уже распакована и отмечена валидной.
  if (existsSync(JAVA_EXE) && existsSync(JAVA_MARKER)) return JAVA_EXE;

  // 1.5) JRE могла распаковаться в подпапку jdk-*/ без маркера (прерванный запуск)
  //      — поднимаем её на уровень, если файлы уже на месте.
  if (!existsSync(JAVA_EXE)) await liftNestedJre();
  if (existsSync(JAVA_EXE) && existsSync(JAVA_MARKER)) return JAVA_EXE;

  // 2) Источник JRE: вшитый zip (если есть) → скачивание с GitHub (Linux).
  const zipTmp = join(app.getPath("temp"), "energyutils-jre");
  try { if (existsSync(zipTmp)) await fs.rm(zipTmp, { force: true }); } catch {}
  if (existsSync(JAVA_ZIP_ASSET)) {
    await fs.copyFile(JAVA_ZIP_ASSET, zipTmp);
  } else if (!existsSync(zipTmp)) {
    // На Linux вшитой JRE в пакете нет — качаем Temurin JRE 21 x64 с GitHub.
    try {
      launchState = { state: "downloading", progress: 0.3, status: "Скачивание HBJVM (Java 21)..." };
      const head = await headInfo(GH_JRE_LINUX).catch(() => null);
      const sz = Number(head && head.length) || 0;
      if (sz > 4 * 1024 * 1024) {
        await downloadFileFast(GH_JRE_LINUX, zipTmp, sz, (got, total) => {
          launchState.progress = 0.3 + 0.4 * (total ? got / total : 0);
        });
      } else {
        await downloadFile(GH_JRE_LINUX, zipTmp, (got, total) => {
          launchState.progress = 0.3 + 0.4 * (total ? got / total : 0);
        });
      }
    } catch (e) {
      launchState = { state: "failed", progress: 0, status: "Не удалось скачать Java: " + String(e && e.message || e) };
      try { await fs.rm(zipTmp, { force: true }); } catch {}
    }
  } else if (process.platform === "win32" && !existsSync(JAVA_ZIP_ASSET)) {
    return existsSync(JAVA_EXE) ? JAVA_EXE : null;
  }

  if (!existsSync(zipTmp)) {
    return existsSync(JAVA_EXE) ? JAVA_EXE : null;
  }
  try {
    mkdirSync(JAVA_DIR, { recursive: true });
    const ok = extractArchive(zipTmp, JAVA_DIR);
    await liftJreDir(JAVA_DIR);
    await liftNestedJre();
    await makeExecutable(JAVA_DIR);
    try { await fs.rm(zipTmp, { force: true }); } catch {}
    if (existsSync(JAVA_EXE)) {
      xplatStripJre(JAVA_DIR);
      // Самопроверка: JRE должна реально запускаться (без неё игра стартовать не будет).
      try {
        const probe = spawnSync(JAVA_EXE, ["-version"], { timeout: 30000, encoding: "utf-8" });
        if (probe.error || probe.status !== 0) {
          const why = probe.error ? String(probe.error.message || probe.error) : String(probe.stderr || probe.stdout).slice(0, 200);
          launchState = { state: "failed", progress: 0, status: "Java не запускается: " + why + ". Проверь установку системных библиотек: sudo apt install libx11-6 libxext6 libxrender1 libxtst6 libxi6 libgl1" };
          try { await fs.rm(JAVA_DIR, { recursive: true, force: true }); } catch {}
          return null;
        }
      } catch (e) {
        launchState = { state: "failed", progress: 0, status: "Не удалось проверить Java: " + String(e && e.message || e) };
        return null;
      }
      await fs.writeFile(JAVA_MARKER, new Date().toISOString());
      hideJarFile(JAVA_EXE);
    } else {
      launchState = { state: "failed", progress: 0, status: "Java распаковалась, но bin/java не найден. Удали папку " + JAVA_DIR + " и перезапусти лаунчер." };
    }
    return existsSync(JAVA_EXE) ? JAVA_EXE : null;
  } catch (e) {
    launchState = { state: "failed", progress: 0, status: "Ошибка распаковки Java: " + String(e && e.message || e) };
    return existsSync(JAVA_EXE) ? JAVA_EXE : null;
  }
}

// Если Expand-Archive сложил JRE в подкаталог jdk-*/ (как устроен zip Temurin),
// переносим содержимое на уровень JAVA_DIR.
async function liftNestedJre() {
  try {
    if (!existsSync(JAVA_DIR)) return;
    const sub = readdirSync(JAVA_DIR).find((d) => /^jdk-/i.test(d));
    if (!sub) return;
    const inner = join(JAVA_DIR, sub);
    for (const ent of readdirSync(inner)) {
      const src = join(inner, ent), dst = join(JAVA_DIR, ent);
      if (existsSync(dst)) continue;
      await fs.rename(src, dst);
    }
    await fs.rmdir(inner);
  } catch {}
}

function bundledJavaFlags(ramMb) {
  return [
    `-Xmx${ramMb}M`,
    ...JAVA_HARDENED_FLAGS,
  ];
}

// Зеркальная копия мода для нативной проты: C:/NativeAntiLeak/mods/EnergyUtils.jar.
const NATIVE_MODS_DIR = join(DATA_HOME, "nativeleak", "mods");
const NATIVE_MOD_JAR = join(NATIVE_MODS_DIR, MOD_FILE_NAME);

function mirrorNativeJar() {
  try {
    // Зеркалим расшифрованный jar (если существует) на время запуска.
    if (!existsSync(MOD_JAR)) return;
    mkdirSync(NATIVE_MODS_DIR, { recursive: true });
    copyFileSync(MOD_JAR, NATIVE_MOD_JAR);
    hideJarFile(NATIVE_MOD_JAR);
  } catch {}
}

// Скрыть jar в Проводнике (Hidden): файлы мода не отображаются в списке папки.
function hideJarFile(p) {
  try {
    if (!existsSync(p)) return;
    hideFile(p, true);
  } catch {}
}

// Старые/лишние копии мода убираем: в mods ХРАНЯТСЯ .enc (постоянно),
// чистый EnergyUtils.jar (только на время игры) и fabric-api.jar.
// Удаляем ЛИШНИЕ jar-дубли энергомода (renderopt и пр.) и .disabled/.tmp.
function removeLegacyMods() {
  try {
    if (!existsSync(MODS_DIR)) return;
    for (const f of readdirSync(MODS_DIR)) {
      const p = join(MODS_DIR, f);
      const lf = f.toLowerCase();
      if (lf === "fabric-api.jar") continue;
      if (lf === "energyutils.jar") continue;       // временный чистый jar — не трогаем
      if (lf.endsWith(".enc") || lf === "energyutils.jar.enc") continue;
      if (lf === "renderopt.jar" || lf.startsWith("renderopt") || lf.startsWith("energyutils") ||
          lf.includes(".disabled") || lf.endsWith(".jar.old") || lf.endsWith(".tmp")) {
        hideFile(p, false);
        rmSync(p, { force: true });
      }
    }
  } catch {}
}

const DEFAULT_SETTINGS = {
  ramGb: 4,
  gameDir: GAME_DIR,
  showQuickLaunch: true,
  updateUrl: UPDATE_BASE,
  selectedVersion: "fabric-1.21.4",
  username: "Player",
  devConsole: false
};

const VERSIONS = [
  { id: "fabric-1.21.4", type: "fabric", version: "1.21.4" },
  { id: "fabric-1.21.4-beta", type: "beta", version: "1.21.4-beta" }
];

let win = null;
let consoleWin = null;
let settings = { ...DEFAULT_SETTINGS };
let launchState = { state: "idle", progress: 0, status: "" };
let javaProcess = null;

// ── Settings ──
async function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(await fs.readFile(SETTINGS_PATH, "utf-8")) };
  } catch { settings = { ...DEFAULT_SETTINGS }; }
  return settings;
}
async function saveSettings() {
  await fs.mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ── Download helpers ──
function downloadFile(url, dest, onProgress) {
  const req = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(url, { headers: { "User-Agent": "EnergyUtils/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(new URL(res.headers.location, url).toString(), dest, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const total = Number(res.headers["content-length"]) || 0;
      let got = 0;
      if (onProgress) res.on("data", (c) => { got += c.length; onProgress(got, total); });
      res.pipe(createWriteStream(dest)).on("finish", resolve).on("error", reject);
    });
    r.on("error", reject); r.setTimeout(45000, () => r.destroy(new Error("timeout"))); r.end();
  });
}
async function fetchJson(url) {
  const req = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(url, { headers: { "User-Agent": "EnergyUtils/1.0" } }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("json")); } });
    });
    r.on("error", reject); r.setTimeout(10000, () => r.destroy(new Error("timeout"))); r.end();
  });
}
function fetchText(url) {
  const req = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(url, { headers: { "User-Agent": "EnergyUtils/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(new URL(res.headers.location, url).toString()).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      res.setEncoding("utf-8");
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    });
    r.on("error", reject); r.setTimeout(10000, () => r.destroy(new Error("timeout"))); r.end();
  });
}
function headInfo(url, depth = 0) {
  const req = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const empty = { etag: "", length: "" };
    const pick = (res) => {
      const len = res.headers["content-length"] || "";
      return { etag: res.headers.etag || "", length: len === "0" ? "" : len };
    };
    const redirect = (res, next) => {
      if (depth < 5 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        headInfo(new URL(res.headers.location, url).toString(), depth + 1).then(done);
        return true;
      }
      return false;
    };
    const usable = (res) => res.statusCode === 200 || res.statusCode === 206;
    const r = req(url, { method: "HEAD", headers: { "User-Agent": "EnergyUtils/1.0" } }, (res) => {
      if (redirect(res)) return;
      res.resume();
      if (!usable(res)) return done(empty);
      const info = pick(res);
      if (info.etag || info.length) return done(info);
      // Хост отдаёт HEAD без валидаторов -> GET и обрыв сразу после заголовков
      // (тело не качаем, валидаторы берём из content-length/etag).
      const g = req(url, { headers: { "User-Agent": "EnergyUtils/1.0" } }, (gres) => {
        if (redirect(gres)) return;
        gres.resume();
        done(usable(gres) ? pick(gres) : empty);
        try { g.destroy(); } catch {}
      });
      g.on("error", () => done(empty));
      g.setTimeout(15000, () => { g.destroy(); done(empty); });
      g.end();
    });
    r.on("error", () => done(empty));
    r.setTimeout(10000, () => { r.destroy(); done(empty); });
    r.end();
  });
}

// Либеральный fetch JSON (не бросает на сетевых ошибках — отдаёт null).
async function fetchJsonLoose(url) {
  try {
    const req = url.startsWith("https:") ? httpsRequest : httpRequest;
    return await new Promise((resolve, reject) => {
      const r = req(url, { headers: { "User-Agent": "EnergyUtils/1.0" } }, (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("json")); } });
      });
      r.on("error", reject); r.setTimeout(15000, () => r.destroy(new Error("timeout"))); r.end();
    });
  } catch { return null; }
}

// ── Быстрая многопоточная загрузка больших файлов (GitHub Release CDN).
// GitHub отдаёт Range (206), поэтому большой клиент/Java качаем 6 потоками.
function downloadFileFast(url, dest, totalBytes, onProgress, threads = 6) {
  const req = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const CHUNK = Math.max(2 * 1024 * 1024, Math.ceil(totalBytes / threads));

    const fetchWithFollow = (u, rangeHeader) => new Promise((res, rej) => {
      const go = (cur, depth) => {
        const r = (cur.startsWith("https:") ? httpsRequest : httpRequest)(cur, {
          headers: { "User-Agent": "EnergyUtils/1.0", Range: rangeHeader }
        }, (resp) => {
          if (resp.statusCode === 302 && resp.headers.location && depth < 5) {
            resp.resume();
            return go(new URL(resp.headers.location, cur).toString(), depth + 1);
          }
          res(resp);
        });
        r.on("error", rej);
        r.setTimeout(60000, () => r.destroy(new Error("timeout")));
        r.end();
      };
      go(u, 0);
    });

    const getChunk = (start, end, outPath) => new Promise((res, rej) => {
      const attempt = (tryNum) => {
        fetchWithFollow(url, `bytes=${start}-${end}`).then((resp) => {
          if (resp.statusCode !== 206) { resp.resume(); return rej(new Error(`HTTP ${resp.statusCode}`)); }
          const out = createWriteStream(outPath, { flags: "w" });
          resp.pipe(out);
          out.on("error", (e) => rej(e));
          resp.on("error", (e) => rej(e));
          out.on("finish", () => res());
        }).catch((e) => {
          try { rmSync(outPath, { force: true }); } catch {}
          if (tryNum < 5) setTimeout(() => attempt(tryNum + 1), 700 * tryNum);
          else rej(e);
        });
      };
      attempt(0);
    });

    (async () => {
      try {
        if (!totalBytes || totalBytes <= 0) throw new Error("Размер файла неизвестен");
        const parts = [];
        for (let start = 0; start < totalBytes; start += CHUNK) parts.push({ start, end: Math.min(start + CHUNK - 1, totalBytes - 1) });
        let doneBytes = 0;
        const { createReadStream, statSync } = await import("node:fs");
        for (let i = 0; i < parts.length; i += threads) {
          const batch = parts.slice(i, i + threads);
          const results = await Promise.allSettled(batch.map((p, j) => {
            const outPath = dest + `.p${i + j}`;
            return getChunk(p.start, p.end, outPath).then(() => {
              try { doneBytes += statSync(outPath).size; } catch {}
              if (onProgress) onProgress(doneBytes, totalBytes);
            });
          }));
          const failed = results.find((r) => r.status === "rejected");
          if (failed) throw failed.reason || new Error("Часть загрузки не удалась (обрыв сети)");
        }
        const out = createWriteStream(dest, { flags: "w" });
        for (let i = 0; i < parts.length; i++) {
          await new Promise((res, rej) => {
            const rs = createReadStream(dest + `.p${i}`);
            rs.on("error", rej);
            rs.pipe(out, { end: false });
            rs.on("end", () => res());
          });
        }
        await new Promise((res) => out.end(res));
        for (let i = 0; i < parts.length; i++) { try { await fs.rm(dest + `.p${i}`, { force: true }); } catch {} }
        const sz = existsSync(dest) ? (await fs.stat(dest)).size : 0;
        if (sz !== totalBytes) throw new Error(`Размер файла не совпадает (${sz}/${totalBytes})`);
        done(resolve);
      } catch (e) { done(reject, e); }
    })();
  });
}

// Скачивание большого файла по частям (лимит хостинга EnergyUtils: 25 МБ/файл).
// Файл на сайте разбит на `fileName.part1..N`; здесь части скачиваются в tmp
// и склеиваются в единый dest.
async function downloadPacked(baseUrl, fileName, parts, dest, onProgress) {
  const written = [];
  try {
    for (let i = 1; i <= parts; i++) {
      const tmp = join(app.getPath("temp"), `eu-part-${Date.now()}-${i}.bin`);
      await downloadFile(`${baseUrl}/${fileName}.part${i}`, tmp, (got, total) => {
        if (onProgress) onProgress(i, parts, got, total);
      });
      written.push(tmp);
    }
    const bufs = [];
    let total = 0;
    for (const p of written) { const b = await fs.readFile(p); bufs.push(b); total += b.length; }
    await fs.writeFile(dest, Buffer.concat(bufs, total));
    return total;
  } finally {
    await Promise.all(written.map((p) => fs.rm(p, { force: true }).catch(() => {})));
  }
}

// ── Offline user ──
function offlineUser() {
  return {
    username: settings.username || "Player",
    subscriptionActive: true,
    subscriptionFrozen: false,
    expiresAt: null
  };
}

// ── Accounts (shared config with the in-game Alt Manager) ──
// Единый источник правды — C:\EnergyUtils\configs\alts.txt (тот же файл,
// который читает/пишет мод в игре: AltManagerScreen). Формат:
//   current=<ник>
//   P<ник>   (закреплённый)
//    <ник>   (обычный)
async function readAlts() {
  let alts = [];
  let current = null;
  try {
    const txt = await fs.readFile(ALTS_PATH, "utf-8");
    for (const line of txt.split(/\r?\n/)) {
      if (line.startsWith("current=")) { current = line.slice(8).trim() || null; continue; }
      if (!line.length) continue;
      if (line.charAt(0) === "P") alts.push({ name: line.slice(1).trim(), pinned: true });
      else alts.push({ name: line.trim(), pinned: false });
    }
  } catch {}
  return { alts, current };
}

async function writeAlts(alts, current) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const lines = [];
  if (current) lines.push("current=" + current);
  for (const a of alts) lines.push((a.pinned ? "P" : " ") + a.name);
  await fs.writeFile(ALTS_PATH, lines.join("\n") + "\n");
}

async function readMeta() {
  try { return JSON.parse(await fs.readFile(ALTS_META_PATH, "utf-8")); } catch { return {}; }
}
async function writeMeta(meta) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(ALTS_META_PATH, JSON.stringify(meta, null, 2));
}

async function ensureAlts() {
  const { alts, current } = await readAlts();
  if (alts.length === 0) await writeAlts([{ name: "Player", pinned: false }], "Player");
  else if (!current || !alts.some(a => a.name === current)) {
    await writeAlts(alts, alts[0].name);
  }
}

async function currentNick() {
  const { alts, current } = await readAlts();
  if (current && alts.some(a => a.name === current)) return current;
  return alts.length ? alts[0].name : (settings.username || "Player");
}

// ── Minecraft client ("встроенный майн") ──
// Клиент лежит В ПАПКЕ ЛАУНЧЕРА: рядом с exe → game/ (minecraft.jar + libs + mods).
// Лаунчер самодостаточен — игра уже встроена в его папку.
// Порядок источников:
//   1) Папка game/ рядом с exe (встроенный клиент — основной путь)
//   2) downloads/minecraft/minecraft-1.21.4.zip на сайте (резерв для других машин)
//   3) Локальная установка AppData/.minecraft (офлайн без сети)
const MC_VERSION = "1.21.4";
const MC_ZIP_ONLINE = `${UPDATE_DIR}/minecraft/minecraft-${MC_VERSION}.zip`;
const MC_SEED_ZIP = join(dirname(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath), "minecraft-1.21.4.zip");
const MC_MANIFEST = join(GAME_DIR, "minecraft-manifest.json");

async function remoteMcInfo() {
  // GitHub Release + фолбэк на HEAD (без API).
  try {
    const rel = await fetchJsonLoose("https://api.github.com/repos/hibera1/minecraft/releases/latest");
    const asset = (rel && rel.assets || []).find((a) => a.name === "minecraft-1.21.4.zip");
    if (asset) {
      return { version: String((rel && rel.tag_name) || "").replace(/^v/i, ""), sha256: asset.digest ? String(asset.digest).replace(/^sha256:/i, "") : "", size: Number(asset.size) || 0, parts: 0, has: true };
    }
  } catch {}
  try {
    const head = await headInfo(GH_CLIENT_ZIP);
    const len = Number(head.length) || 0;
    return { version: "1.21.4", sha256: "", size: len > 0 ? len : 0, parts: 0, has: len > 0 };
  } catch {
    return { version: "", sha256: "", size: 0, parts: 0, has: false };
  }
}
async function readMcManifest() {
  try { return JSON.parse(await fs.readFile(MC_MANIFEST, "utf-8")); } catch { return null; }
}
async function writeMcManifest(data) {
  await fs.mkdir(GAME_DIR, { recursive: true });
  await fs.writeFile(MC_MANIFEST, JSON.stringify(data, null, 2));
}

// Проверка, что клиент стоит и совпадает с последней версией на GitHub.
async function checkGameInstalled() {
  // Клиент считается установленным ТОЛЬКО при наличии jar + хотя бы одной
  // библиотеки + валидного манифеста. Пустая папка libs = недокачан.
  if (!existsSync(join(GAME_DIR, "minecraft.jar")) || !existsSync(LIBS_DIR)) return false;
  try {
    const jars = readdirSync(LIBS_DIR).filter((f) => f.toLowerCase().endsWith(".jar"));
    if (!jars.length) return false;
  } catch { return false; }
  const l = await readMcManifest();
  if (!l || !l.version) return false;
  const r = await remoteMcInfo();
  if (!r.has) return true;   // GitHub недоступен — верим локальному
  return l.version === r.version;
}

// Распаковка zip с клиентом в C:/EnergyUtils/game (без сторонних утилит).
async function extractMcZip(zipPath) {
  return extractArchive(zipPath, GAME_DIR);
}

// Falls back: если интернета нет, пробуем подтянуть клиент из локальной .
// установки пользователя (AppData/.minecraft) — быстро и без сети.
async function tryInstallFromLocalMinecraft() {
  try {
    const home = app.getPath("home");
    const candidates = [
      join(home, ".minecraft", "versions", `Fabric ${MC_VERSION}`, `Fabric ${MC_VERSION}.jar`),
      join(home, ".minecraft", "versions", MC_VERSION, `${MC_VERSION}.jar`),
    ];
    const jarSrc = candidates.find((p) => existsSync(p));
    if (!jarSrc) return false;
    mkdirSync(GAME_DIR, { recursive: true });
    await fs.copyFile(jarSrc, join(GAME_DIR, "minecraft.jar"));
    // Копируем библиотеки из .minecraft/libraries плоским списком.
    const libsRoot = join(home, ".minecraft", "libraries");
    if (existsSync(libsRoot)) {
      mkdirSync(LIBS_DIR, { recursive: true });
      const walk = async (dir) => {
        for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
          const p = join(dir, ent.name);
          if (ent.isDirectory()) await walk(p);
          else if (ent.name.toLowerCase().endsWith(".jar")) {
            try { await fs.copyFile(p, join(LIBS_DIR, ent.name), { flag: "wx" }); } catch {}
          }
        }
      };
      await walk(libsRoot);
    }
    await writeMcManifest({ version: MC_VERSION, source: "local", installedAt: Date.now() });
    return existsSync(join(GAME_DIR, "minecraft.jar"));
  } catch { return false; }
}

async function ensureGame(force) {
  const libsEmpty = () => { try { return !readdirSync(LIBS_DIR).some((f) => f.toLowerCase().endsWith(".jar")); } catch { return true; } };
  const hasJar = existsSync(join(GAME_DIR, "minecraft.jar"));

  // Уже стоит и актуальна → ничего не делаем.
  if (!force && await checkGameInstalled()) return { ok: true };
  if (!force && hasJar && !libsEmpty() && existsSync(LIBS_DIR)) return { ok: true };

  // 1) Локальный zip-сид рядом с exe (офлайн-раздача через флешку).
  if (existsSync(MC_SEED_ZIP)) {
    launchState = { state: "downloading", progress: 0.2, status: "Распаковка встроенного Minecraft..." };
    if (await extractMcZip(MC_SEED_ZIP)) {
      await writeMcManifest({ version: MC_VERSION, source: "seed", installedAt: Date.now() });
      launchState = { state: "idle", progress: 0, status: "" };
      return { ok: true };
    }
  }
  // 2) Онлайн: качаем клиент с GitHub CDN одним файлом (быстро, без обрезов).
  const mc = await remoteMcInfo();
  const tmp = join(app.getPath("temp"), `mc-${MC_VERSION}.zip`);
  launchState = { state: "downloading", progress: 0.2, status: "Скачивание Minecraft с GitHub..." };
  try {
    const onMcProgress = (got, total) => {
      launchState.progress = 0.2 + 0.6 * (total ? got / total : 0);
      launchState.gotBytes = got; launchState.totalBytes = total;
    };
    const sz = Number(mc.size) || 0;
    if (sz > 8 * 1024 * 1024) {
      await downloadFileFast(GH_CLIENT_ZIP, tmp, sz, onMcProgress);
    } else {
      await downloadFile(GH_CLIENT_ZIP, tmp, onMcProgress);
    }
    const buf = await fs.readFile(tmp);
    if (mc.sha256) {
      const hash = createHash("sha256").update(buf).digest("hex");
      if (hash.toLowerCase() !== mc.sha256.toLowerCase()) throw new Error("Клиент повреждён: контрольная сумма не совпадает");
    } else if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error("Некорректный ZIP");
    }
    launchState = { state: "downloading", progress: 0.85, status: "Распаковка Minecraft..." };
    if (!await extractMcZip(tmp)) throw new Error("Не удалось распаковать клиент");
    await fs.rm(tmp, { force: true });
    await writeMcManifest({ version: mc.version || MC_VERSION, sha256: mc.sha256, source: "online", installedAt: Date.now() });
    launchState = { state: "idle", progress: 0, status: "" };
    return { ok: true };
  } catch (e) {
    try { await fs.rm(tmp, { force: true }); } catch {}
    // Офлайн-фолбэк: локальная установка Minecraft пользователя.
    if (await tryInstallFromLocalMinecraft()) {
      launchState = { state: "idle", progress: 0, status: "" };
      return { ok: true };
    }
    launchState = { state: "failed", progress: 0, status: String(e.message || e) };
    return { ok: false, error: "Не удалось установить Minecraft: " + String(e.message || e) };
  }
}

// ── Launch ──
async function analysisGate() {
  const gate = await detectAnalysisTools();
  if (!gate.blocked) return null;
  const detail = gateSummary(gate.hits);
  launchState = { state: "failed", progress: 1, status: "Запуск заблокирован: " + detail };
  return { ok: false, error: "Запуск заблокирован: обнаружен отладчик/реверс-инструмент (" + detail + ")" };
}

// ── Sanitize libs: лечит известные конфликты, которые роняют KnotClient.
//    - weye-floader.jar = кастомный fabric-loader (0.16.14), дублирует классы
//      со стандартным loader → «duplicate fabric loader classes found».
//    - sponge-mixin-0.15.x от набора Zenith несовместим с loader 0.19.3
//      (NoClassDefFoundError IAdviceProvider) → подменяем вшитым 0.17.3.
const EMBEDDED_MIXIN = join(__dirname, "..", "assets", "libs", "sponge-mixin-0.17.3+mixin.0.8.7.jar");
function sanitizeLibs() {
  try {
    if (!existsSync(LIBS_DIR)) return;
    for (const f of readdirSync(LIBS_DIR)) {
      const p = join(LIBS_DIR, f);
      const lf = f.toLowerCase();
      // Удаляем ВСЕ следы weye-floader (jar, jar.disabled, disabled — Fabric видит любой файл в classpath)
      if (lf.startsWith("weye-") && (lf.includes(".jar") || lf.includes("loader"))) {
        try { rmSync(p, { force: true }); } catch {}
        continue;
      }
      if (lf.startsWith("sponge-mixin-0.15") && lf.includes(".jar")) {
        try { rmSync(p, { force: true }); } catch {}
        continue;
      }
    }
    // Ставим правильный mixin из ресурсов, если его нет.
    if (existsSync(EMBEDDED_MIXIN)) {
      const hasOk = readdirSync(LIBS_DIR).some((f) => f.toLowerCase().startsWith("sponge-mixin-0.17"));
      if (!hasOk) {
        copyFileSync(EMBEDDED_MIXIN, join(LIBS_DIR, "sponge-mixin-0.17.3+mixin.0.8.7.jar"));
      }
    }
  } catch {}
}

// Только настоящие jar-файлы попадают в classpath (никаких .disabled/.tmp/длл).
function libJars() {
  try {
    return existsSync(LIBS_DIR)
      ? readdirSync(LIBS_DIR).filter((f) => f.toLowerCase().endsWith(".jar"))
      : [];
  } catch { return []; }
}

async function doLaunch(quickServer) {
  const blocked = await analysisGate();
  if (blocked) return blocked;

  // Лечим libs перед каждым запуском (конфликтующие loader/mixin не должны ломать старт).
  sanitizeLibs();

// Мод обновляется в фоне при старте (whenReady → autoUpdateJar). Здесь НЕ ждём
  // сеть: если мод уже стоит — запускаем сразу со старой версией. Если его нет —
  // ставим с прогрессом (без него игра не стартует).
  if (!existsSync(MOD_JAR_ENC) && !existsSync(MOD_JAR)) {
    const up = await installMod();
    if (!up.ok) return { ok: false, error: "Не удалось установить мод: " + (up.error || "нет соединения") };
  }
  // Расшифровываем мод на время игры (чистый jar — прямо в mods, как читает Fabric).
  if (existsSync(MOD_JAR_ENC) && !existsSync(MOD_JAR)) {
    const ok = await prepareModForLaunch();
    if (!ok) return { ok: false, error: "Не удалось расшифровать мод (файл повреждён). Переустанови мод кнопкой «Скачать мод»." };
  }
  const clientJar = join(GAME_DIR, "minecraft.jar");
  const libsOk = (() => { try { return existsSync(LIBS_DIR) && readdirSync(LIBS_DIR).some((f) => f.toLowerCase().endsWith(".jar")); } catch { return false; } })();
  // Клиент «установлен» только если есть jar И хотя бы одна библиотека.
  if (!existsSync(clientJar) || !libsOk) {
    const inst = await ensureGame();
    if (!inst.ok) return inst;
  }
  if (!existsSync(clientJar) || !libsOk) {
    return { ok: false, error: "Minecraft не установлен. Подключи интернет и нажми «Запуск» — лаунчер скачает клиент сам." };
  }
  const javaBin = await ensureBundledJava();
  if (!javaBin) {
    return { ok: false, error: "Встроенная Java не найдена. Переустановите лаунчер." };
  }
  const libs = libJars();
  const cp = [clientJar, ...libs.map(f => join(LIBS_DIR, f))].join(delimiter);
  const ramMb = Math.max(1024, Math.round((settings.ramGb || 4) * 1024));

  const args = [
    ...bundledJavaFlags(ramMb),
    "-cp", cp,
    "-Djava.library.path=" + LIBS_DIR,
    "-DFabricMcEmu=net.minecraft.client.main.Main",
    "net.fabricmc.loader.impl.launch.knot.KnotClient",
    "--gameDir", GAME_DIR,
    "--username", await currentNick(),
    "--uuid", "00000000-0000-0000-0000-000000000000",
    "--accessToken", "0",
    "--userType", "legacy",
    "--version", "1.21.4"
  ];
  if (quickServer) args.push("--quickPlayMultiplayer", quickServer.includes(":") ? quickServer : `${quickServer}:25565`);

  // Первый гейт уже отработал в начале doLaunch, времени между ним и spawn()
  // достаточно мало — повторный дорогой PS-скан не нужен, срезаем его, чтобы
  // ускорить запуск (watchdog продолжит следить во время игры).

  javaProcess = spawn(javaBin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: false, cwd: GAME_DIR });
  javaProcess.unref();
  // Скрываем лаунчер, пока игра открыта (Minecraft поверх) — «напоминалка» уже
  // показана в UI, а при выходе из игры окно лаунчера возвращается.
  try { if (win && !win.isDestroyed()) win.hide(); } catch {}
  // Пишем консоль игры в файл (для консоли разработчика и диагностики киков).
  LOGS_DIR = join(GAME_DIR, "logs");
  try { mkdirSync(LOGS_DIR, { recursive: true }); } catch {}
  const logStream = createWriteStream(join(LOGS_DIR, "launcher-console.log"), { flags: "a" });
  logStream.write(`\n===== Запуск ${new Date().toISOString()} =====\n`);
  javaProcess.stdout?.on("data", (d) => { try { logStream.write(d); } catch {} });
  javaProcess.stderr?.on("data", (d) => { try { logStream.write(d); } catch {} });
  javaProcess.on("error", () => {
    try { logStream.end(); } catch {}
    stopWatchdog();
    cleanupModAfterLaunch().catch(() => {});
    launchState = { state: "failed", progress: 1, status: "Встроенная Java не запустилась" };
  });
  javaProcess.on("exit", (code) => {
    try { logStream.end(`\n===== Выход код ${code} ${new Date().toISOString()} =====\n`); } catch {}
    stopWatchdog();
    // Стираем расшифрованный мод после выхода из игры.
    cleanupModAfterLaunch().catch(() => {});
    // Игра закрылась — возвращаем окно лаунчера.
    try { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } catch {}
  });

  // Второй контур защиты: инструмент, открыто уже ПОСЛЕ прохождения гейта,
  // вычисляется сканером окон/процессов и роняет игровую сессию.
  stopWatchdog();
  startWatchdog((hits) => {
    const detail = gateSummary(hits);
    try { javaProcess?.kill(); } catch {}
    stopWatchdog();
    launchState = { state: "failed", progress: 1, status: "Запуск заблокирован: " + detail };
  }, 4000);

  launchState = { state: "running", progress: 1, status: "Запуск игры..." };

  // Живая консоль Minecraft: если включена в настройках — открываем окно сразу при старте.
  if (settings.devConsole) openConsoleWindow();

  return { ok: true };
}

// ── Update mod from GitHub ──
async function remoteJarInfo() {
  // GitHub Release + фолбэк на прямой HEAD (без API — он часто недоступен).
  try {
    const rel = await fetchJsonLoose("https://api.github.com/repos/hibera1/minecraft/releases/latest");
    const asset = (rel && rel.assets || []).find((a) => a.name === "EnergyUtils.jar.enc");
    if (asset) {
      return {
        version: String((rel && rel.tag_name) || "").replace(/^v/i, ""),
        launcherVersion: "", parts: 0,
        sha256: asset.digest ? String(asset.digest).replace(/^sha256:/i, "") : "",
        size: Number(asset.size) || 0, has: true
      };
    }
  } catch {}
  try {
    const head = await headInfo(GH_MOD_JAR);
    const len = Number(head.length) || 0;
    return { version: "1.1.0", launcherVersion: "", parts: 0, sha256: "", size: len > 0 ? len : 0, has: len > 0 };
  } catch {
    return { version: "", launcherVersion: "", parts: 0, sha256: "", size: 0, has: false };
  }
}

// Информация о новых версиях самого ЛАУНЧЕРА:
// сайт → downloads/launcher/version.json + downloads/launcher/EnergyUtils.exe.part1..N.
async function remoteLauncherInfo() {
  try {
    const meta = await fetchJson(`${LAUNCHER_UPDATE_DIR}/version.json`);
    const parts = Number(meta.parts) || 0;
    return {
      version: String(meta.version || ""),
      fileName: String(meta.fileName || "EnergyUtils.exe"),
      sha256: String(meta.sha256 || ""),
      size: Number(meta.size) || 0,
      parts,
      has: !!(meta.version && meta.fileName && (parts > 0 || meta.single))
    };
  } catch {
    return { has: false, version: "", fileName: "EnergyUtils.exe", sha256: "", size: 0, parts: 0 };
  }
}

async function readModManifest() {
  try { return JSON.parse(await fs.readFile(MOD_MANIFEST, "utf-8")); } catch { return null; }
}
async function writeModManifest(data) {
  await fs.mkdir(MODS_DIR, { recursive: true });
  await fs.writeFile(MOD_MANIFEST, JSON.stringify(data, null, 2));
}

// МОД ШИФРУЕТСЯ В ПОКОЕ: в mods лежит ТОЛЬКО .enc. Чистый jar создаётся
// на время запуска прямо в mods (KnotClient игнорирует --modsDir и грузит моды
// только из gameDir/mods) и удаляется сразу после выхода из игры.
// ВАЖНО: НЕ прятать файл (вообще) — Fabric пропускает скрытые/невидимые jar.
async function prepareModForLaunch() {
  try {
    if (!existsSync(MOD_JAR_ENC)) return false;
    if (!existsSync(MOD_JAR)) {
      const enc = await fs.readFile(MOD_JAR_ENC);
      const merged = decodeModAny(enc);
      if (!merged) return false;
      const tmp = MOD_JAR + ".tmp";
      await fs.writeFile(tmp, merged);
      await fs.rename(tmp, MOD_JAR);
    }
    return existsSync(MOD_JAR);
  } catch { return false; }
}
async function cleanupModAfterLaunch() {
  try { if (existsSync(MOD_JAR)) await fs.rm(MOD_JAR, { force: true }); } catch {}
}

async function seedJar() {
  try {
    if (existsSync(MOD_JAR_ENC)) { mirrorNativeJar(); return false; }
    // Чистый jar в mods — мусор от старой версии: удаляем и берём .enc, если есть.
    if (existsSync(MOD_JAR)) { await fs.rm(MOD_JAR, { force: true }).catch(() => {}); }
    if (!existsSync(SEED_JAR)) return false;
    mkdirSync(MODS_DIR, { recursive: true });
    const src = await fs.readFile(SEED_JAR);
    // Шифрование: нативный encodeMod, иначе JS-осироченный (Linux без нативки).
    let enc = null;
    try { if (typeof euEncode === "function") enc = euEncode(src); } catch {}
    if (!enc) {
      const out = Buffer.allocUnsafe(src.length);
      for (let i = 0; i < src.length; i++) out[i] = src[i] ^ (MOD_ENC_KEY_MASKED[i & 31] ^ 0xA5);
      enc = out;
    }
    if (!enc) return false;
    await fs.writeFile(MOD_JAR_ENC, enc);
    mirrorNativeJar();
    return true;
  } catch { return false; }
}

async function checkUpdate() {
  try {
    const remote = await remoteJarInfo();
    if (!remote.has) {
      const local0 = await readModManifest();
      return { available: false, version: remote.version, current: local0?.version || null };
    }
    if (!existsSync(MOD_JAR_ENC)) return { available: true, version: remote.version, current: null };

    // Честное сравнение: SHA-256 зашифрованного .enc на диске против digest ассета.
    let localEncSha = "";
    try {
      localEncSha = createHash("sha256").update(await fs.readFile(MOD_JAR_ENC)).digest("hex");
    } catch { localEncSha = ""; }
    const remoteSha = (remote.sha256 || "").toLowerCase();
    const available = !!remoteSha && localEncSha.toLowerCase() !== remoteSha;
    return { available, version: remote.version, current: (await readModManifest())?.version || null };
  } catch {
    return { available: false, error: "unreachable" };
  }
}

let updateState = { state: "idle", progress: 0, status: "" };
let updating = false;
let launcherUpdating = false;

async function installMod() {
  if (updating) return { ok: true, busy: true };
  updating = true;
  updateState = { state: "checking", progress: 0, status: "Получение данных о версии" };
  try {
    const meta = await remoteJarInfo();
    if (!meta.has) throw new Error("Нет данных о версии");
    mkdirSync(MODS_DIR, { recursive: true });

    // Мод качается одним файлом с GitHub CDN (быстро, без обрезов Cloudflare).
    const dlDir = join(app.getPath("temp"), "eu-mod-dl");
    mkdirSync(dlDir, { recursive: true });
    const p = join(dlDir, "eu-mod.enc");
    updateState = { state: "downloading", progress: 0.3, status: "Скачивание мода..." };
    const onModProgress = (got, total) => {
      updateState.progress = 0.3 + 0.5 * (total ? got / total : 0);
      updateState.gotBytes = got; updateState.totalBytes = total;
    };
    const dSize = Number(meta.size) || 0;
    if (dSize > 4 * 1024 * 1024) {
      await downloadFileFast(GH_MOD_JAR, p, dSize, onModProgress);
    } else {
      await downloadFile(GH_MOD_JAR, p, onModProgress);
    }

    updateState = { state: "verifying", progress: 0.9, status: "Расшифровка и проверка целостности" };
    const enc = await fs.readFile(p);
    // SHA сверяем по СКАЧАННОМУ .enc (GitHub digest считается от .enc).
    const dlSha = createHash("sha256").update(enc).digest("hex");
    if (meta.sha256 && dlSha.toLowerCase() !== meta.sha256.toLowerCase()) throw new Error("Контрольная сумма не совпадает");
    if (meta.size && enc.length !== meta.size) throw new Error("Некорректный размер файла");
    // Расшифровка: нативный модуль, либо встроенный JS-фолбэк (Linux без .node).
    let merged = null;
    if (typeof euDecode === "function") merged = euDecode(enc);
    if (!merged || merged.length < 4 || merged[0] !== 0x50 || merged[1] !== 0x4b) throw new Error("Не удалось расшифровать мод (файл повреждён)");
    await fs.rm(p, { force: true }).catch(() => {});

    // На диск сохраняем ТОЛЬКО зашифрованный .enc. Чистый jar появится
    // лишь на время запуска игры (prepareModForLaunch) во временной папке.
    const tmpEnc = MOD_JAR_ENC + ".tmp";
    await fs.writeFile(tmpEnc, enc);
    if (existsSync(MOD_JAR)) await fs.rm(MOD_JAR, { force: true });
    if (existsSync(MOD_JAR_ENC)) await fs.rm(MOD_JAR_ENC);
    await fs.rename(tmpEnc, MOD_JAR_ENC);
    await cleanupModAfterLaunch().catch(() => {});

    await writeModManifest({
      version: meta.version, sha256: meta.sha256, fileName: MOD_FILE_NAME, updatedAt: Date.now()
    });

    updateState = { state: "done", progress: 1, status: "Обновлено" };
    return { ok: true, version: meta.version };
  } catch (e) {
    updateState = { state: "failed", progress: 0, status: String(e.message || e) };
    return { ok: false, error: String(e.message || e) };
  } finally {
    updating = false;
  }
}

async function autoUpdateJar() {
  if (updating) return false;
  await seedJar();
  await ensureFabricApi();
  const info = await checkUpdate();
  if (!info.available) return false;
  return (await installMod()).ok === true;
}

// Fabric API — обязательная библиотека-мод для EnergyUtils (depends fabric-api).
// Файл на GitHub CDN (быстро, как и весь мод); сайт не используем.
async function ensureFabricApi() {
  const apiPath = join(MODS_DIR, "fabric-api.jar");
  try {
    if (existsSync(apiPath) && (await fs.stat(apiPath)).size > 500000) return;
    mkdirSync(MODS_DIR, { recursive: true });
    const tmp = apiPath + ".tmp";
    await downloadFile(GH_FABRIC_API, tmp);
    const st = await fs.stat(tmp);
    if (st.size < 500000) throw new Error("fabric-api: bad size");
    if (existsSync(apiPath)) await fs.rm(apiPath);
    await fs.rename(tmp, apiPath);
    hideJarFile(apiPath);
  } catch {
    try { await fs.rm(apiPath + ".tmp", { force: true }); } catch {}
  }
}

// ── Window ──
const WINDOW_ICON = join(__dirname, "../assets/icons/app.ico");
function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 650,
    resizable: false, maximizable: false, fullscreenable: false,
    frame: false, backgroundColor: "#141417",
    icon: WINDOW_ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      sandbox: true,
      devTools: false,
      preload: join(__dirname, "preload.cjs")
    }
  });
  // Hardening: deny renderer-opened windows, block navigation away from app pages.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file:")) e.preventDefault();
  });
  win.loadFile(join(__dirname, "../ui/loading.html"));
  win.webContents.on("did-finish-load", () => {
    win.webContents.insertCSS(
      ".titlebar{-webkit-app-region:drag;}" +
      ".btn-wc,.account-pill,.logo-down,.window-controls,.popup,.nav-btn,.version-card,.game-card,.ql-servers,.server-pill{-webkit-app-region:no-drag;}"
    ).catch(() => {});
  });
}

// ── Окно «Консоль запуска» (живой вывод Minecraft + последний кик) ──
function openConsoleWindow() {
  if (consoleWin && !consoleWin.isDestroyed()) { consoleWin.focus(); return; }
  consoleWin = new BrowserWindow({
    width: 900, height: 560,
    backgroundColor: "#0e0e12",
    icon: WINDOW_ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      preload: join(__dirname, "preload.cjs")
    }
  });
  consoleWin.loadFile(join(__dirname, "../ui/console.html"));
  consoleWin.on("closed", () => { consoleWin = null; });
}

// ── IPC ──
function handle(name, fn) {
  ipcMain.handle("native:" + name, async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return undefined; }
  });
}

app.whenReady().then(async () => {
  await loadSettings();
  await ensureAlts();

  // window
  handle("ready", () => {});
  handle("hide", () => win?.minimize());
  handle("close", () => win?.close());
  handle("dragMove", () => {});
  handle("copyToClipboard", (text) => { if (text) clipboard.writeText(String(text)); });
  handle("openUrl", (url) => { if (url && /^https?:\/\//.test(url)) shell.openExternal(url); });
  handle("openFolder", () => shell.openPath(GAME_DIR));
  handle("openUserMods", () => shell.openPath(MODS_DIR));
  handle("openManualUpdate", () => shell.openExternal("https://t.me/energyutils"));

  // offline auth
  handle("authState", async () => ({ state: "confirmed", user: { ...offlineUser(), username: await currentNick() } }));
  handle("authTryRestore", () => true);
  handle("authStart", () => true);
  handle("authLogout", () => {});
  handle("fetchAvatar", () => null);
  handle("stashCache", () => {});
  handle("startMicrosoftLogin", () => {});
  handle("microsoftLoginStatus", () => "idle");
  handle("cancelMicrosoftLogin", () => {});

  // accounts (nicks) — общий файл с модом
  handle("getAccounts", async () => {
    const { alts } = await readAlts();
    const meta = await readMeta();
    return alts.map(a => ({
      id: a.name, name: a.name, type: "local",
      addedAt: meta[a.name] || "недавно", pinned: a.pinned
    }));
  });
  handle("getSelectedAccount", async () => currentNick());
  handle("setSelectedAccount", async (id) => {
    const name = String(id || "").trim();
    const { alts } = await readAlts();
    if (!name || !alts.some(a => a.name === name)) return;
    await writeAlts(alts, name);
    settings.username = name; saveSettings();
    return name;
  });
  handle("addAccount", async (name, type) => {
    const n = String(name || "").trim().replace(/[^a-zA-Z0-9_]/g, "");
    if (n.length < 3 || n.length > 16) return null;
    const { alts, current } = await readAlts();
    if (alts.some(a => a.name === n)) return null;
    alts.push({ name: n, pinned: false });
    const meta = await readMeta();
    meta[n] = new Date().toISOString().slice(0, 10);
    await writeMeta(meta);
    await writeAlts(alts, current || n);
    if (!current) { settings.username = n; saveSettings(); }
    return { id: n, name: n, type: "local", addedAt: meta[n], pinned: false };
  });
  handle("removeAccount", async (id) => {
    const name = String(id || "");
    let { alts, current } = await readAlts();
    const before = alts.length;
    alts = alts.filter(a => a.name !== name);
    if (alts.length === before) return;
    if (current === name) current = alts.length ? alts[0].name : null;
    await writeAlts(alts, current);
    if (current) { settings.username = current; saveSettings(); }
    return current;
  });

  // versions / launch
  handle("getVersions", () => VERSIONS);
  handle("getSelectedVersion", () => settings.selectedVersion);
  handle("setSelectedVersion", (id) => { settings.selectedVersion = String(id || ""); saveSettings(); });
  handle("launchStart", (quick) => doLaunch(typeof quick === "string" ? quick : ""));
  handle("launchCancel", () => {});
  handle("launchProgress", () => launchState);
  handle("getSystemRam", () => Math.max(1, Math.round(os.totalmem() / 1073741824)));
  handle("setRam", (gb) => { settings.ramGb = Math.max(1, Number(gb) || 4); saveSettings(); });
  handle("setGameDir", (p) => { if (typeof p === "string" && p) settings.gameDir = p; saveSettings(); });
  handle("getSettings", () => settings);
  handle("getShowQuickLaunch", () => settings.showQuickLaunch !== false);
  handle("setShowQuickLaunch", (v) => { settings.showQuickLaunch = v !== false; saveSettings(); });

  // mods
  handle("listMods", async () => {
    try {
      if (!existsSync(MODS_DIR)) return { ok: true, mods: [] };
      const files = readdirSync(MODS_DIR).filter(f => f.toLowerCase().endsWith(".jar")).sort();
      const mods = [];
      for (const f of files) {
        try {
          const st = await fs.stat(join(MODS_DIR, f));
          mods.push({ id: f, name: f.replace(/\.jar$/i, ""), filename: f, size: st.size, status: "installed_current" });
        } catch (_) {}
      }
      return { ok: true, mods };
    } catch (_) {
      return { ok: true, mods: [] };
    }
  });
  handle("deleteMod", async (filename) => {
    try {
      const p = join(MODS_DIR, String(filename || ""));
      if (dirname(p) !== MODS_DIR) return { ok: false, error: "bad path" };
      await fs.unlink(p);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  handle("downloadMod", async () => {
    const r = await installMod();
    return r.ok ? { ok: true } : { ok: false, error: r.error || "Ошибка обновления" };
  });
  handle("installGame", async (opts) => ensureGame(!!(opts && opts.force)));
  handle("gameStatus", async () => ({
    installed: existsSync(join(GAME_DIR, "minecraft.jar")) && existsSync(LIBS_DIR),
    version: (await readMcManifest())?.version || null
  }));

  // update — mod
  handle("checkModUpdate", async () => checkUpdate());
  handle("checkLauncherUpdate", async () => {
    const r = await remoteLauncherInfo();
    const cur = app.getVersion();
    const remote = r.version;
    const same = remote && /^[0-9.]+$/.test(remote) && remote === cur;
    let newer = false;
    if (remote && /^[0-9.]+$/.test(remote) && /^[0-9.]+$/.test(cur)) {
      const pa = remote.split(".").map((n) => parseInt(n, 10) || 0);
      const pb = cur.split(".").map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const a = pa[i] || 0, b = pb[i] || 0;
        if (a > b) { newer = true; break; }
        if (a < b) break;
      }
    }
    return { available: newer, version: remote, current: cur, error: r.has ? null : "unreachable" };
  });
  handle("startLauncherUpdate", async () => {
    if (launcherUpdating) return { ok: true, busy: true };
    const info = await remoteLauncherInfo();
    if (!info.has) return { ok: false, error: "Нет данных о новой версии" };
    launcherUpdating = true;
    try {
      // Скачиваем новый exe в temp рядом с текущим и подменяем после выхода.
      // Для portable-сборки process.execPath — распакованный в %TEMP% рантайм,
      // поэтому настоящий exe берём из PORTABLE_EXECUTABLE_FILE (ставит electron-builder).
      const curExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      const dir = dirname(curExe);
      const newExe = join(dir, "EnergyUtils.new.exe");
      updateState = { state: "downloading", progress: 0, status: "Скачивание новой версии..." };
      if (info.parts > 1) {
        await downloadPacked(LAUNCHER_UPDATE_DIR, info.fileName, info.parts, newExe, (i, all, got, total) => {
          updateState.progress = ((i - 1) + (total ? got / total : 0)) / all;
        });
      } else {
        await downloadFile(`${LAUNCHER_UPDATE_DIR}/${info.fileName}`, newExe, (got, total) => {
          updateState.progress = total ? got / total : 0;
        });
      }
      updateState = { state: "verifying", progress: 0.9, status: "Проверка целостности..." };
      const buf = await fs.readFile(newExe);
      if (info.size && buf.length !== info.size) { await fs.rm(newExe, { force: true }); throw new Error("Некорректный размер файла"); }
      if (info.sha256) {
        const hash = createHash("sha256").update(buf).digest("hex");
        if (hash.toLowerCase() !== info.sha256.toLowerCase()) { await fs.rm(newExe, { force: true }); throw new Error("Контрольная сумма не совпадает"); }
      }
      // Планируем замену скриптом, который дождётся выхода приложения.
      const oldExe = join(dir, "EnergyUtils.old" + (process.platform === "win32" ? ".exe" : ""));
      updateState = { state: "launching", progress: 1, status: "Запуск новой версии..." };
      if (process.platform === "win32") {
        const updaterPs1 = join(app.getPath("temp"), "energyutils-updater.ps1");
        const ps = [
          "$ErrorActionPreference='SilentlyContinue'",
          `$old='${oldExe.replace(/'/g, "''")}'; $new='${newExe.replace(/'/g, "''")}'; $exe='${curExe.replace(/'/g, "''")}'`,
          "Remove-Item $old -Force -ErrorAction Ignore",
          "Rename-Item $exe $old -Force -ErrorAction Ignore",
          "Move-Item $new $exe -Force",
          "Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)",
          "Remove-Item $PSCommandPath -Force -ErrorAction Ignore"
        ].join("\n");
        await fs.writeFile(updaterPs1, ps, "utf-8");
        const upd = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", updaterPs1], {
          detached: true, stdio: "ignore", windowsHide: true
        });
        upd.unref();
      } else {
        // Linux/macOS: shell-скрипт подменяет AppImage/бинарник и перезапускает.
        const updaterSh = join(app.getPath("temp"), "energyutils-updater.sh");
        const sh = `#!/bin/sh
sleep 2
old='${oldExe.replace(/'/g, "'\\''")}'
new='${newExe.replace(/'/g, "'\\''")}'
exe='${curExe.replace(/'/g, "'\\''")}'
rm -f "$old"
[ -f "$exe" ] && mv -f "$exe" "$old"
mv -f "$new" "$exe"
chmod +x "$exe"
nohup "$exe" >/dev/null 2>&1 &
rm -f "$0"
`;
        await fs.writeFile(updaterSh, sh, "utf-8");
        const upd = spawn("/bin/sh", [updaterSh], { detached: true, stdio: "ignore" });
        upd.unref();
      }
      setTimeout(() => { try { app.exit(0); } catch {} }, 400);
      return { ok: true };
    } catch (e) {
      updateState = { state: "failed", progress: 0, status: String(e.message || e) };
      return { ok: false, error: String(e.message || e) };
    } finally {
      setTimeout(() => { launcherUpdating = false; }, 5000);
    }
  });
  handle("updateProgress", () => updateState);

  handle("getDevConsole", () => !!settings.devConsole);
  handle("setDevConsole", (v) => {
    settings.devConsole = v === true;
    saveSettings();
    if (settings.devConsole) openConsoleWindow();
    return settings.devConsole;
  });

  // ── Консоль разработчика: последний кик, логи майна за 15 дней, консоль запуска ──
  handle("getDevToolsInfo", async () => {
    const out = { consoleLog: "", lastKick: null, recentLogs: [] };
    try {
      const consoleFile = join(LOGS_DIR, "launcher-console.log");
      if (existsSync(consoleFile)) {
        const b = await fs.readFile(consoleFile);
        out.consoleLog = b.toString("utf8").slice(-60000);
      }
    } catch {}
    try {
      if (existsSync(CRASH_DIR)) {
        const crashes = readdirSync(CRASH_DIR).filter((f) => f.endsWith(".txt")).sort();
        if (crashes.length) {
          const last = crashes[crashes.length - 1];
          const txt = await fs.readFile(join(CRASH_DIR, last), "utf-8");
          const firstLines = txt.split(/\r?\n/).slice(0, 14).join("\n");
          out.lastKick = { file: last, preview: firstLines.slice(0, 1200) };
        }
      }
    } catch {}
    try {
      if (existsSync(LOGS_DIR)) {
        const cutoff = Date.now() - 15 * 24 * 3600 * 1000;
        const logs = readdirSync(LOGS_DIR).filter((f) => f.endsWith(".log") && !f.startsWith("launcher-"));
        for (const f of logs) {
          try {
            const st = await fs.stat(join(LOGS_DIR, f));
            if (st.mtimeMs >= cutoff) out.recentLogs.push({ file: f, size: st.size, mtime: st.mtimeMs });
          } catch {}
        }
        out.recentLogs.sort((a, b) => b.mtime - a.mtime);
      }
    } catch {}
    return out;
  });
  handle("openLogsFolder", () => {
    try { mkdirSync(LOGS_DIR, { recursive: true }); } catch {}
    shell.openPath(LOGS_DIR);
  });
  handle("openCrashFolder", () => {
    try { mkdirSync(CRASH_DIR, { recursive: true }); } catch {}
    shell.openPath(CRASH_DIR);
  });

  removeLegacyMods();
  await seedJar();
  mirrorNativeJar();
  createWindow();
  autoUpdateJar();
  // Фоновая подготовка: клиент (если недокачан) + распаковка/скачивание JRE.
  (async () => {
    try {
      const libsHasJar = (() => { try { return existsSync(LIBS_DIR) && readdirSync(LIBS_DIR).some((f) => f.toLowerCase().endsWith(".jar")); } catch { return false; } })();
      if (!existsSync(join(GAME_DIR, "minecraft.jar")) || !libsHasJar) {
        await ensureGame();
      }
    } catch {}
  })();
  (async () => { try { await ensureBundledJava(); } catch {} })();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => stopWatchdog());
