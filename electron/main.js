import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Tray, Menu, Notification } from "electron";
import { promises as fs, existsSync, mkdirSync, readdirSync, createWriteStream, rmSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { detectAnalysisTools, gateSummary, startWatchdog, stopWatchdog } from "./antiAnalysis.js";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import os from "node:os";

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Кроссплатформенность: Windows → C:/EnergyUtils, Linux/macOS → ~/.energyutils
const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const HOME_DIR = app.getPath("home");
const OS_ROOT = IS_WIN ? "C:/EnergyUtils" : join(HOME_DIR, ".energyutils");

// Папка лаунчера (рядом с exe). Для portable-сборки process.execPath указывает
// на распакованный в %TEMP% рантайм, поэтому реальный exe берём из env-переменной.
const APP_DIR = dirname(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
// «Встроенный майн»: если рядом с лаунчером лежит папка game/ (minecraft.jar + libs + mods),
// играем оттуда — лаунчер уже самодостаточен и в его папке. Иначе фолбэк: OS_ROOT/game.
const LOCAL_GAME_DIR = join(APP_DIR, "game");
const GAME_DIR = existsSync(join(OS_ROOT, "game")) ? join(OS_ROOT, "game") : (existsSync(LOCAL_GAME_DIR) ? LOCAL_GAME_DIR : join(OS_ROOT, "game"));
const LIBS_DIR = join(GAME_DIR, "libs");
const MODS_DIR = join(GAME_DIR, "mods");
// Настройки/аккаунты тоже рядом с лаунчером, чтобы всё было переносимым.
const LOCAL_CONFIG_DIR = join(APP_DIR, "configs");
const CONFIG_DIR = existsSync(join(OS_ROOT, "configs")) ? join(OS_ROOT, "configs") : (existsSync(LOCAL_CONFIG_DIR) ? LOCAL_CONFIG_DIR : join(OS_ROOT, "configs"));
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
// Мод + клиент + fabric-api из hibera1/minecraft, сам лаунчер — hibera1/launcher.
const GH_OWNER = "hibera1";
const GH_MC = `https://github.com/${GH_OWNER}/minecraft/releases/download/v1.21.4`;
const GH_LR = `https://github.com/${GH_OWNER}/launcher/releases/download/v2.0.0`;
const GH_MOD_JAR = `${GH_MC}/EnergyUtils.jar.enc`;
// Ключ расшифровки мода (16-байтный потоковый XOR). Вшит ТОЛЬКО в лаунчер,
// в файлах мода и клиента его нет — «сырой» jar из GitHub не собрать.
const MOD_ENC_KEY = Buffer.from([0x7A, 0x3F, 0xC1, 0x9B, 0x52, 0xE4, 0x0D, 0x38, 0xF6, 0x2B, 0xA8, 0x74, 0x1C, 0x95, 0xE0, 0x63, 0x47, 0x8D, 0x1A, 0xBE, 0x36, 0xF9, 0x5C, 0x02, 0xA7, 0xE9, 0x4B, 0xD0, 0x6E, 0x85, 0x13, 0xC7]);
function decryptMod(data) {
  const out = Buffer.alloc(data.length);
  let j = 0;
  for (let i = 0; i < data.length; i++) { out[i] = data[i] ^ MOD_ENC_KEY[j]; j = (j + 1) % MOD_ENC_KEY.length; }
  return out;
}
const GH_CLIENT_ZIP = `${GH_MC}/minecraft-1.21.4.zip`;
const GH_FABRIC_API = `${GH_MC}/fabric-api.jar`;
const GH_LAUNCHER_EXE = `${GH_LR}/EnergyUtils.exe`;
const SEED_JAR = join(app.getPath("home"), "Downloads", "EnergyUtils.jar");
// Файл мода лежит в mods под нейтральным «модовым» именем — сам mod id внутри
// fabric.mod.json от имени файла не зависит, поэтому ничего ломается.
const MOD_FILE_NAME = "EnergyUtils.jar";
const MOD_JAR = join(MODS_DIR, MOD_FILE_NAME);
// Мод на диске хранится ВСЕГДА зашифрованным (.enc). Чистый jar появляется
// только на время запуска игры (prepareModForLaunch) и удаляется после выхода.
const MOD_JAR_ENC = join(MODS_DIR, "EnergyUtils.jar.enc");
const MOD_MANIFEST = join(MODS_DIR, "manifest.json");

// ── HBJVM (кастомная Java 21) ──
// JRE качается с GitHub при ПЕРВОМ запуске. Windows: bin/HBJVM.exe (java.exe
// переименован), Linux: bin/java (симлинк сохраняем как java). Запуск —
// только через HBJVM-имя. Флаги запрещают attach/агенты/JMX/perf-дампы.
const JAVA_DIR = join(GAME_DIR, "java");
const JAVA_EXE = IS_WIN ? join(JAVA_DIR, "bin", "HBJVM.exe") : join(JAVA_DIR, "bin", "java");
const JAVA_ZIP_REMOTE = IS_WIN ? `${GH_MC}/jre21.zip` : `${GH_MC}/jre21-linux.tar.gz`;
const JAVA_MARKER = join(JAVA_DIR, "energyutils-java-ok");

// Жёсткие флаги: без javaagent/instrumentation, без attach, без JDWP-порта,
// без perf-данных; OOM — мгновенный выход. Дампы ядра и heap выключены.
// Java 21: динамические агенты (agentlib/agentpath/attach) запрещены отдельно.
const JAVA_HARDENED_FLAGS = [
  "-XX:+DisableAttachMechanism",     // запрет attach-агентов и инструментов
  "-XX:-EnableDynamicAgentLoading",  // Java 21: динамические агенты не грузятся
  "-XX:-UsePerfData",                // не создавать hsperfdata (нет утечки метаданных)
  "-XX:+ExitOnOutOfMemoryError",     // OOM = аварийный выход, без зависания
  "-XX:-CreateCoredumpOnCrash",      // запрет core dump при краше
  "-XX:-HeapDumpOnOutOfMemoryError", // не писать heap dump при OOM
  "-XX:-ManagementServer",           // нет JMX-порта, нечем подключаться
  "-Xrs",                            // минимум реакций на сигналы ОС
  "-Dfile.encoding=UTF-8",
  "-Djava.net.preferIPv4Stack=true",
];

// Урезаем JRE от инструментов, которыми можно снять дамп/запустить сервисы.
// Списки по платформе: Windows .exe/.dll, Linux — соответствующие бинарники.
const JRE_STRIP_WIN = [
  "jfr.exe", "jrunscript.exe", "jwebserver.exe", "rmiregistry.exe",
  "keytool.exe", "kinit.exe", "klist.exe", "ktab.exe",
  "jhsdb.exe", "jcmd.exe", "jmap.exe", "jstack.exe", "jdb.exe",
  "jstat.exe", "jinfo.exe", "jps.exe", "jimage.exe", "jlink.exe",
  "javac.exe", "javadoc.exe", "jar.exe", "jarsigner.exe", "jdeps.exe",
  "jpackage.exe", "jrunimage.exe", "serialver.exe", "wsgen.exe", "wsimport.exe",
  "orbd.exe", "policytool.exe", "rmid.exe", "servertool.exe", "tnameserv.exe",
  "hcspdserv.exe", "jabswitch.exe", "jaccessinspector.exe", "jaccesswalker.exe",
  "jmod.exe", "javaw.exe", "jshell.exe", "jconsole.exe", "jstatd.exe",
  "rmic.exe", "schemagen.exe", "xjc.exe", "native2ascii.exe",
  "jfr", "jaotc", "jdwp",
];
const JRE_STRIP_LINUX = [
  "jfr", "jrunscript", "jwebserver", "rmiregistry", "keytool", "kinit", "klist", "ktab",
  "jhsdb", "jcmd", "jmap", "jstack", "jdb", "jstat", "jinfo", "jps", "jimage", "jlink",
  "javac", "javadoc", "jar", "jarsigner", "jdeps", "jpackage", "serialver", "rmic",
  "jshell", "jconsole", "jstatd", "orbd", "rmid", "jaotc", "jdwp", "native2ascii",
  "schemagen", "wsgen", "wsimport", "xjc", "policytool",
];
const JRE_STRIP = IS_WIN ? JRE_STRIP_WIN : JRE_STRIP_LINUX;
const JRE_STRIP_DIRS = IS_WIN
  ? ["lib\\jfr", "legal", "conf\\management", "lib\\src.zip", "man", "include", "demo", "sample", "lib\\ct.sym", "lib\\jdk.hotspot.agent"]
  : ["lib/jfr", "legal", "conf/management", "lib/src.zip", "man", "include", "demo", "sample", "lib/ct.sym", "lib/jdk.hotspot.agent"];

async function stripJre() {
  try {
    if (!existsSync(JAVA_DIR)) return;
    const bin = join(JAVA_DIR, "bin");
    for (const f of JRE_STRIP) {
      try { const p = join(bin, f); if (existsSync(p)) await fs.rm(p, { force: true }); } catch {}
    }
    for (const rel of JRE_STRIP_DIRS) {
      try { const p = join(JAVA_DIR, rel); if (existsSync(p)) await fs.rm(p, { recursive: true, force: true }); } catch {}
    }
    if (IS_WIN) {
      // Windows: java.exe → HBJVM.exe (запуск только через HBJVM).
      const javaBin = join(bin, "java.exe");
      if (existsSync(javaBin) && !existsSync(JAVA_EXE)) await fs.rename(javaBin, JAVA_EXE);
      for (const p of [join(bin, "attach.dll"), join(bin, "java.management.dll"), join(JAVA_DIR, "lib", "jfr"),
        join(bin, "jdwp.dll"), join(bin, "dt_socket.dll"), join(bin, "instrument.dll"),
        join(bin, "management_agent.dll"), join(bin, "javaaccessbridge.dll"),
        join(bin, "windowsaccessbridge-64.dll"), join(bin, "splashscreen.dll")]) {
        try { if (existsSync(p)) await fs.rm(p, { force: true }); } catch {}
      }
    } else {
      // Linux: удаляем libattach.so и qktools
      for (const p of [join(JAVA_DIR, "lib", "amd64", "libattach.so"), join(JAVA_DIR, "lib", "libattach.so")]) {
        try { if (existsSync(p)) await fs.rm(p, { force: true }); } catch {}
      }
    }
    for (const rel of ["lib\\amd64\\libattach.so", "lib\\modules_attach", "lib\\jrt-fs.jar", "lib/amd64/libattach.so", "lib/modules_attach", "lib/jrt-fs.jar"]) {
      try { const p = join(JAVA_DIR, rel); if (existsSync(p)) await fs.rm(p, { recursive: true, force: true }); } catch {}
    }
    const inner = readdirSync(JAVA_DIR).find((d) => /^jdk-/i.test(d) && d !== "jdk-21");
    if (inner) { try { await fs.rm(join(JAVA_DIR, inner), { recursive: true, force: true }); } catch {} }
    hideJarFile(JAVA_EXE);
  } catch {}
}

async function ensureBundledJava(forceRedownload) {
  // 1) Уже распакована и отмечена валидной (HBJVM.exe на месте).
  if (!forceRedownload && existsSync(JAVA_EXE) && existsSync(JAVA_MARKER)) return JAVA_EXE;

  // 1.5) JRE могла распаковаться в подпапку jdk-*/ без маркера (прерванный запуск)
  //      — поднимаем её на уровень, если файлы уже на месте.
  if (!forceRedownload && !existsSync(JAVA_EXE)) await liftNestedJre();

  // Прерванная распаковка (папка есть, а HBJVM.exe нет) — чистим и качаем заново,
  // иначе лаунчер «не запускается» после отмены первой установки.
  if (!forceRedownload && existsSync(JAVA_DIR) && !existsSync(JAVA_EXE)) {
    try { await fs.rm(JAVA_DIR, { recursive: true, force: true }); } catch {}
  }

  // 2) Скачиваем JRE с GitHub CDN и распаковываем (однократно, первый запуск).
  try {
    mkdirSync(JAVA_DIR, { recursive: true });
    const zipTmp = join(app.getPath("temp"), "hbjvm-jre.zip");
    launchState = { state: "downloading", progress: 0.3, status: "Скачивание HBJVM (Java 21)..." };
    await downloadFile(JAVA_ZIP_REMOTE, zipTmp, (got, total) => {
      launchState.progress = 0.3 + 0.4 * (total ? got / total : 0);
    });
    launchState = { state: "downloading", progress: 0.75, status: "Распаковка HBJVM..." };
    const r = await extractZipTo(zipTmp, JAVA_DIR);
    try { await fs.rm(zipTmp, { force: true }); } catch {}
    if (!r) return existsSync(JAVA_EXE) ? JAVA_EXE : null;
    await liftNestedJre();
    await stripJre();
    if (!existsSync(JAVA_EXE)) {
      // Если исходник был java.exe — stripJre уже переименовал; иначе попробуем снова.
      const jBin = join(JAVA_DIR, "bin", "java.exe");
      if (existsSync(jBin)) await fs.rename(jBin, JAVA_EXE);
    }
    await fs.writeFile(JAVA_MARKER, new Date().toISOString());
    return existsSync(JAVA_EXE) ? JAVA_EXE : null;
  } catch {
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
    // Linux: java/release-файлы могут быть с правами -x после zip; chmod.
    if (!IS_WIN) {
      try {
        const { execFileSync } = await import("node:child_process");
        for (const f of ["java", "keytool", "jrunscript", "jcmd", "jmap", "jstack"]) {
          const p = join(JAVA_DIR, "bin", f);
          if (existsSync(p)) execFileSync("chmod", ["+x", p]);
        }
      } catch {}
    }
  } catch {}
}

function bundledJavaFlags(ramMb) {
  // Производительность: как у TL — G1GC с короткими паузами, нет байткод-
  // проверок, HugeTLB, без маппинговых барьеров ради FPS. Лимита ФПС нет.
  const perf = [
    "-XX:+UseG1GC",
    "-XX:MaxGCPauseMillis=50",
    "-XX:+UseStringDeduplication",
    "-XX:-DontCompileHugeMethods",
    "-XX:+OptimizeStringConcat",
    "-XX:+UseCompressedOops",
    "-Xss4M",
    "-Dlog4j2.isThreadContextMapInheritable=true",
  ];
  return [
    `-Xmx${ramMb}M`,
    ...JAVA_HARDENED_FLAGS,
    ...perf,
  ];
}

// Зеркальная копия мода для нативной проты: C:/NativeAntiLeak/mods/EnergyUtils.jar.
const NATIVE_MODS_DIR = "C:/NativeAntiLeak/mods";
const NATIVE_MOD_JAR = join(NATIVE_MODS_DIR, MOD_FILE_NAME);

function mirrorNativeJar() {
  try {
    // Зеркалим расшифрованный jar (если существует) в нативную папку защиты.
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
    spawnSync("attrib", ["+h", p], { windowsHide: true, timeout: 5000 });
  } catch {}
}
// Мод в mods НЕ скрываем (юзер должен видеть, что скачано); атрибут снимаем.
function showJarFile(p) {
  try {
    if (!existsSync(p)) return;
    spawnSync("attrib", ["-h", p], { windowsHide: true, timeout: 5000 });
  } catch {}
}

// Старые/лишние копии мода убираем навсегда: два jar с одним mod id (=energyutils) ломают Fabric.
// Оставляем только эталонный EnergyUtils.jar (качает лаунчер) и fabric-api.jar.
function removeLegacyMods() {
  try {
    if (!existsSync(MODS_DIR)) return;
    for (const f of readdirSync(MODS_DIR)) {
      const p = join(MODS_DIR, f);
      if (!f.toLowerCase().endsWith(".jar")) continue;
      const lf = f.toLowerCase();
      if (lf === "energyutils.jar" || lf === "fabric-api.jar") continue;
      spawnSync("attrib", ["-h", p], { windowsHide: true, timeout: 5000 });
      rmSync(p, { force: true });
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
// Скачивание с устойчивостью к обрывам Cloudflare: докачка по Range + ретраи.
// Большие файлы его зона режет, поэтому часть считается скачанной только когда
// получили весь байт; сломанный хвост дописывается повторным запросом.
function downloadFile(url, dest, onProgress) {
  const req = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const attempt = async (tryNum) => {
      let started = 0;
      try { started = existsSync(dest) ? (await fs.stat(dest)).size : 0; } catch { started = 0; }
      const headers = { "User-Agent": "EnergyUtils/1.0" };
      if (started > 0) headers.Range = "bytes=" + started + "-";
      const r = req(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadFile(new URL(res.headers.location, url).toString(), dest, onProgress).then(resolve).catch(reject);
        }
        // 206 = докачка с места обрыва, 200 = с начала (сервер не поддержал Range).
        if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const total = Number(res.headers["content-length"] || 0) + (res.statusCode === 206 ? started : 0);
        let got = started;
        const mode = res.statusCode === 206 ? "a" : "w";
        const out = createWriteStream(dest, { flags: mode });
        if (onProgress) res.on("data", (c) => { got += c.length; onProgress(got, total); });
        res.pipe(out);
        const fail = (e) => {
          out.destroy();
          const gotNow = got;
          if (tryNum < 6) {
            setTimeout(() => attempt(tryNum + 1).then(resolve).catch(reject), 600 * tryNum);
          } else {
            reject(e || new Error("Обрыв загрузки (повторные попытки не удались)"));
          }
          void gotNow;
        };
        out.on("finish", resolve);
        out.on("error", fail);
        res.on("error", fail);
        r.setTimeout(60000, () => r.destroy(new Error("timeout")));
      });
      r.on("error", (e) => {
        if (tryNum < 6) setTimeout(() => attempt(tryNum + 1).then(resolve).catch(reject), 600 * tryNum);
        else reject(e);
      });
      r.end();
    };
    attempt(0);
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
//   2) ЗВУКИ: официальный CDN Mojang (resources.download.minecraft.net) — быстрый,
//      не зависит от Cloudflare-зоны и не требует заливки на сайт
//   3) Локальная установка AppData/.minecraft (офлайн без сети)
const MC_VERSION = "1.21.4";
const MC_ZIP_ONLINE = `${UPDATE_DIR}/minecraft/minecraft-${MC_VERSION}.zip`;
const MC_SEED_ZIP = join(dirname(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath), "minecraft-1.21.4.zip");
const MC_BUNDLED_ZIP = join(__dirname, "..", "assets", "client", `minecraft-${MC_VERSION}.zip`);
const MC_MANIFEST = join(GAME_DIR, "minecraft-manifest.json");
const MOJANG_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const MOJANG_RESOURCES = "https://resources.download.minecraft.net";

// Скачивание отдельных файлов официального клиента: маленький коннектор-хелпер
// поверх downloadFile (тот уже умеет ретраи/докачку), с лимитом параллельности.
async function downloadFileSeq(url, dest, onProgress) {
  return downloadFile(url, dest, onProgress);
}

// Полное зеркало веб-запроса без ретраев (для мелких json).
async function fetchJsonLoose(url) {
  return fetchJson(url);
}

// Узнаём URL официального сборочного манифеста для MC_VERSION.
async function officialVersionUrl() {
  const manifest = await fetchJsonLoose(MOJANG_MANIFEST);
  const v = (manifest.versions || []).find((x) => x.id === MC_VERSION);
  return v ? v.url : null;
}

// Тянем ВСЕ ассеты (indexes/objects) напрямую с Mojang CDN.
// Нужны не только звуки: модели, текстуры, шрифты и ресурспаки блоков лежат
// в том же индексе — без них «Unable to bake model» и кривые текстуры.
async function ensureVanillaSounds() {
  const assetsDir = join(GAME_DIR, "assets");
  const indexesDir = join(assetsDir, "indexes");
  const objectsDir = join(assetsDir, "objects");
  try {
    const verUrl = await officialVersionUrl();
    if (!verUrl) return false;
    const ver = await fetchJsonLoose(verUrl);
    const assetIndex = ver.assetIndex;
    if (!assetIndex || !assetIndex.url || !assetIndex.id) return false;

    const idxPath = join(indexesDir, `${assetIndex.id}.json`);
    if (!existsSync(idxPath) || (await fs.stat(idxPath)).size <= 0) {
      mkdirSync(indexesDir, { recursive: true });
      await downloadFileSeq(assetIndex.url, idxPath);
    }
    const idx = JSON.parse(await fs.readFile(idxPath, "utf-8"));
    const objs = idx.objects || {};

    // ВСЕ объекты индекса (модели, текстуры, звуки, шрифты).
    const keys = Object.keys(objs).filter((k) => objs[k] && objs[k].hash);

    // Пропускаем уже скачанные, собираем очередь недостающих.
    const missing = [];
    for (const k of keys) {
      const h = objs[k].hash;
      const sub = h.slice(0, 2);
      const dest = join(objectsDir, sub, h);
      if (existsSync(dest) && (await fs.stat(dest)).size > 0) continue;
      mkdirSync(join(objectsDir, sub), { recursive: true });
      missing.push({ url: `${MOJANG_RESOURCES}/${sub}/${h}`, dest });
    }

    // Параллельная загрузка 12 потоками.
    const CONCURRENCY = 12;
    let done = 0;
    const worker = async () => {
      while (missing.length) {
        const task = missing.shift();
        try {
          await downloadFileSeq(task.url, task.dest);
        } catch {
          // молча пропускаем сбой одного файла — остальные идут дальше
        }
        done++;
        launchState = { state: "downloading", progress: 0.8 + 0.18 * (done / Math.max(keys.length, 1)), status: `Ассеты: ${done}/${keys.length}` };
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(missing.length, 1)) }, worker));

    await writeMcManifest({ version: MC_VERSION, source: "vanilla-assets", assetIndexId: assetIndex.id, installedAt: Date.now() });
    return true;
  } catch (e) {
    return false;
  }
}

async function remoteMcInfo() {
  try {
    const meta = await fetchJson(`${UPDATE_DIR}/minecraft/version.json`);
    return { version: String(meta.version || ""), sha256: String(meta.sha256 || ""), size: Number(meta.size) || 0, parts: Number(meta.parts) || 0, has: !!meta.version };
  } catch { return { version: "", sha256: "", size: 0, parts: 0, has: false }; }
}
async function readMcManifest() {
  try { return JSON.parse(await fs.readFile(MC_MANIFEST, "utf-8")); } catch { return null; }
}
async function writeMcManifest(data) {
  await fs.mkdir(GAME_DIR, { recursive: true });
  await fs.writeFile(MC_MANIFEST, JSON.stringify(data, null, 2));
}

// Проверка, что клиент стоит и совпадает с последней версией на сайте.
async function checkGameInstalled() {
  if (!existsSync(join(GAME_DIR, "minecraft.jar")) || !existsSync(LIBS_DIR)) return false;
  const l = await readMcManifest();
  const r = await remoteMcInfo();
  if (!l) return true;                       // на сайте нет данных — считаем установленным
  if (!r.has) return true;
  return l.version === r.version;            // версия клиента не устарела
}

// Распаковка zip/cлайента в GAME_DIR. bsdtar в разы быстрее PowerShell Expand-Archive.
async function extractMcZip(zipPath) {
  const r = spawnSync("tar.exe", ["-xf", zipPath, "-C", GAME_DIR], { windowsHide: true, timeout: 300000 });
  return r.status === 0;
}

// Распаковка zip в произвольную папку (bsdtar).
async function extractZipTo(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync("tar.exe", ["-xf", zipPath, "-C", destDir], { windowsHide: true, timeout: 300000 });
  return r.status === 0;
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
  // Уже стоит и актуальна → ничего не делаем.
  if (!force && await checkGameInstalled()) return { ok: true };
  if (!force && existsSync(join(GAME_DIR, "minecraft.jar")) && existsSync(LIBS_DIR)) return { ok: true };

  // 1) Локальный сид рядом с exe (встроенный клиент game/ — должен был уже лежать).
  if (existsSync(join(GAME_DIR, "minecraft.jar")) && existsSync(LIBS_DIR)) {
    await writeMcManifest({ version: MC_VERSION, source: "bundled", installedAt: Date.now() });
    return { ok: true };
  }
  // 2) Локальный zip-сид рядом с exe (офлайн-раздача через флешку).
  if (existsSync(MC_SEED_ZIP)) {
    launchState = { state: "downloading", progress: 0.2, status: "Распаковка встроенного Minecraft..." };
    if (await extractMcZip(MC_SEED_ZIP)) {
      await writeMcManifest({ version: MC_VERSION, source: "seed", installedAt: Date.now() });
      launchState = { state: "idle", progress: 0, status: "" };
      return { ok: true };
    }
  }
  // 3) Онлайн: качаем клиент с GitHub CDN одним файлом (быстро,
  //    без частей и обрезов Cloudflare-зоны).
  const mc = await remoteMcInfo();
  if (mc.has || true) {
    const tmp = join(app.getPath("temp"), `mc-${MC_VERSION}.zip`);
    launchState = { state: "downloading", progress: 0.2, status: "Скачивание Minecraft с GitHub..." };
    try {
      await downloadFile(GH_CLIENT_ZIP, tmp, (got, total) => {
        launchState.progress = 0.2 + 0.6 * (total ? got / total : 0);
      });
      const buf = await fs.readFile(tmp);
      if (mc.sha256) {
        const hash = createHash("sha256").update(buf).digest("hex");
        if (hash.toLowerCase() !== mc.sha256.toLowerCase()) throw new Error("Клиент повреждён: контрольная сумма не совпадает");
      } else {
        // На сайте sha клиента старые части (могут не совпадать с GitHub-файлом)
        // — сверяем только сигнатуру zip.
        if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error("Некорректный ZIP");
      }
      launchState = { state: "downloading", progress: 0.85, status: "Распаковка Minecraft..." };
      if (!await extractMcZip(tmp)) throw new Error("Не удалось распаковать клиент");
      await fs.rm(tmp, { force: true });
      await writeMcManifest({ version: mc.version || MC_VERSION, sha256: mc.sha256, source: "online", installedAt: Date.now() });
      launchState = { state: "idle", progress: 0, status: "" };
      return { ok: true };
    } catch (e) {
      try { await fs.rm(tmp, { force: true }); } catch {}
      // 3) Офлайн-фолбэк: локальная установка Minecraft пользователя.
      if (await tryInstallFromLocalMinecraft()) {
        launchState = { state: "idle", progress: 0, status: "" };
        return { ok: true };
      }
      launchState = { state: "failed", progress: 0, status: String(e.message || e) };
      return { ok: false, error: "Не удалось установить Minecraft: " + String(e.message || e) };
    }
  }
  return { ok: false, error: "Нет данных об установке Minecraft" };
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

// Стандартные настройки клиента: guiScale 2, VSync выключен (фпс выше).
// Пишем options.txt перед каждым запуском, чтобы лаунчер всегда диктовал
// эти два параметра; остальное оставляем как было.
async function applyGameOptions() {
  try {
    const opt = join(GAME_DIR, "options.txt");
    let lines = [];
    if (existsSync(opt)) {
      try { lines = (await fs.readFile(opt, "utf-8")).split(/\r?\n/); } catch {}
    }
    const set = (key, val) => {
      const i = lines.findIndex((l) => l.startsWith(key + ":"));
      if (i >= 0) lines[i] = `${key}:${val}`;
      else lines.push(`${key}:${val}`);
    };
    set("guiScale", "2");
    set("vsync", "false");
    set("maxFps", "0");                    // лимит FPS выключен (как в TL)
    set("fpsLimit", "0");
    mkdirSync(GAME_DIR, { recursive: true });
    await fs.writeFile(opt, lines.join("\n"), "utf-8");
  } catch {}
}

// Сброс настроек игры: options.txt к «чистому» стандарту лаунчера.
// Используется из Настроек (кнопка «Сбросить»), когда юзер всё сломал.
async function resetGameOptions() {
  try {
    const opt = join(GAME_DIR, "options.txt");
    mkdirSync(GAME_DIR, { recursive: true });
    const clean = [
      "guiScale:2",
      "vsync:false",
      "maxFps:0",
      "fpsLimit:0",
      "fullscreen:false",
      "renderDistance:12",
      "gamma:0.5",
      "clouds:true",
      "particles:0",
      "mipmapLevels:4",
      "ao:true",
      "entityShadows:true",
      "fov:1.0",
      "mouseSensitivity:0.5",
    ].join("\n");
    await fs.writeFile(opt, clean, "utf-8");
    return { ok: true, path: opt };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

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

async function doLaunch(quickServer, opts = {}) {
  const blocked = await analysisGate();
  if (blocked) return blocked;

  // Лечим libs перед каждым запуском (конфликтующие loader/mixin не должны ломать старт).
  sanitizeLibs();
  await applyGameOptions();

  // Если мода нет — СТАВИМ ЕГО САМИ (автоустановка при запуске), а не молчим.
  if (!existsSync(MOD_JAR_ENC) && !opts.force) {
    launchState = { state: "downloading", progress: 0.1, status: "Установка мода..." };
    const up = await installMod();
    if (!up.ok) return { ok: false, code: "MOD_MISSING", error: up.error };
  }
  // Расшифровываем мод на время игры (на диске лежит только .enc).
  if ((existsSync(MOD_JAR_ENC)) && !existsSync(MOD_JAR)) {
    await prepareModForLaunch();
  }
  // HBJVM (Java 21) — скачивается при первом запуске.
  const javaBin = await ensureBundledJava();
  if (!javaBin) {
    return { ok: false, error: "HBJVM (Java 21) не установлена. Проверьте интернет." };
  }
  const clientJar = join(GAME_DIR, "minecraft.jar");
  // Если клиента нет — САМИ скачиваем и распаковываем с GitHub (+ звуки с Mojang).
  if ((!existsSync(clientJar) || !existsSync(LIBS_DIR)) && !opts.force) {
    const inst = await ensureGame();
    if (!inst.ok) return { ok: false, code: "CLIENT_MISSING", error: inst.error || "Не удалось установить Minecraft" };
    await ensureVanillaSounds().catch(() => {});
  }
  // При force без мода/клиента всё равно пробуем запустить с тем, что есть, —
  // если файлов нет, Java сама упадёт с понятной ошибкой в консоли.
  if (!existsSync(clientJar)) {
    return { ok: false, code: "CLIENT_MISSING" };
  }
  const libs = libJars();
  const cp = [clientJar, ...libs.map(f => join(LIBS_DIR, f))].join(";");
  // #28: если свободной памяти мало — автоматически срезаем запрос, чтобы
  // лаунчер не падал с OOM при старте игры.
  let ramGb = settings.ramGb || 4;
  try {
    const freeGb = (os.freemem ? os.freemem() : 0) / 1073741824;
    if (freeGb < ramGb + 1) {
      ramGb = Math.max(1, Math.floor(freeGb - 0.5));
      launchState = { state: "launching", progress: 0.1, status: `Мало памяти — выделено ${ramGb} ГБ` };
    }
  } catch {}
  const ramMb = Math.max(1024, Math.round(ramGb * 1024));

  const args = [
    ...bundledJavaFlags(ramMb),
    "-cp", cp,
    "-Djava.library.path=" + LIBS_DIR,
    "-DFabricMcEmu=net.minecraft.client.main.Main",
    "net.fabricmc.loader.impl.launch.knot.KnotClient",
    "--gameDir", GAME_DIR,
    "--assetsDir", join(GAME_DIR, "assets"),
    "--assetIndex", "19",
    "--username", await currentNick(),
    "--uuid", "00000000-0000-0000-0000-000000000000",
    "--accessToken", "0",
    "--userType", "legacy",
    "--version", "1.21.4"
  ];
  if (quickServer) args.push("--quickPlayMultiplayer", quickServer.includes(":") ? quickServer : `${quickServer}:25565`);

  // Второй проход гейта прямо перед спавном: за время между кликом и запуском
  // инструмент могли открыть — ловим и не даём стартовать под наблюдателем.
  try {
    const gate2 = await detectAnalysisTools();
    if (gate2.blocked) {
      const detail = gateSummary(gate2.hits);
      stopWatchdog();
      launchState = { state: "failed", progress: 1, status: "Запуск заблокирован: " + detail };
      return { ok: false, error: "Запуск заблокирован: обнаружен отладчик/реверс-инструмент (" + detail + ")" };
    }
  } catch {}

  javaProcess = spawn(javaBin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: false, cwd: GAME_DIR });
  javaProcess.unref();
  // #27: фиксируем игровую сессию (для календаря).
  try { await fs.mkdir(GAME_DIR, { recursive: true }); } catch {}
  try {
    const p = join(GAME_DIR, "session-log.json");
    let sessions = [];
    try { sessions = JSON.parse(await fs.readFile(p, "utf-8")); } catch {}
    if (!Array.isArray(sessions)) sessions = [];
    const today = new Date().toISOString().slice(0, 10);
    const last = sessions[sessions.length - 1];
    if (!last || last.date !== today) sessions.push({ date: today, ts: Date.now() });
    await fs.writeFile(p, JSON.stringify(sessions.slice(-730)), "utf-8");
  } catch {}
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
    cleanupModAfterLaunch();
    launchState = { state: "failed", progress: 1, status: "Встроенная Java не запустилась" };
  });
  javaProcess.on("exit", (code) => {
    try { logStream.end(`\n===== Выход код ${code} ${new Date().toISOString()} =====\n`); } catch {}
    stopWatchdog();
    // Игра закрылась — возвращаем окно лаунчера и стираем расшифрованный мод.
    cleanupModAfterLaunch();
    try { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } catch {}
  });

  // Второй контур защиты: инструмент, открыто уже ПОСЛЕ прохождения гейта,
  // вычисляется сканером окон/процессов и роняет игровую сессию.
  // Первые 2 минуты после старта — часто (4с), потом реже (12с), чтобы не
  // грузить CPU в долгой сессии (гоняем всех приаттачиваться в момент запуска).
  let wdTicks = 0;
  stopWatchdog();
  startWatchdog((hits) => {
    const detail = gateSummary(hits);
    try { javaProcess?.kill(); } catch {}
    stopWatchdog();
    launchState = { state: "failed", progress: 1, status: "Запуск заблокирован: " + detail };
  }, 4000);
  // Переключаем на 12с после первых 30 тиков (≈2 минуты).
  const slowDown = setInterval(() => {
    wdTicks++;
    if (wdTicks >= 30) {
      clearInterval(slowDown);
      stopWatchdog();
      startWatchdog((hits) => {
        const detail = gateSummary(hits);
        try { javaProcess?.kill(); } catch {}
        stopWatchdog();
        launchState = { state: "failed", progress: 1, status: "Запуск заблокирован: " + detail };
      }, 12000);
    }
  }, 1000);
  javaProcess.on("exit", () => { try { clearInterval(slowDown); } catch {} });

  launchState = { state: "running", progress: 1, status: "Запуск игры..." };

  // Живая консоль Minecraft: если включена в настройках — открываем окно сразу при старте.
  if (settings.devConsole) openConsoleWindow();

  return { ok: true };
}

// ── Update mod (файл на GitHub CDN, метаданные на сайте) ──
async function remoteJarInfo() {
  // Источник правды — downloads/version.json на сайте: версия, SHA-256 и размер.
  // Сам jar отдаёт GitHub Release (hibera1/minecraft) — быстро и без обрезов.
  const meta = await fetchJson(`${UPDATE_DIR}/version.json`);
  const parts = Number(meta.parts) || 0;
  return {
    version: String(meta.version || ""),
    launcherVersion: String(meta.launcherVersion || ""),
    parts,
    sha256: String(meta.sha256 || ""),
    size: Number(meta.size) || 0,
    has: !!meta.version
  };
}

// Информация о новых версиях самого ЛАУНЧЕРА:
// файл — GitHub Release (hibera1/launcher), метаданные sha/size — GitHub API.
async function remoteLauncherInfo() {
  try {
    // GitHub API последнего релиза даёт точный digest/size ассета.
    const rel = await fetchJsonLoose("https://api.github.com/repos/hibera1/launcher/releases/latest");
    const asset = (rel.assets || []).find((a) => a.name === "EnergyUtils.exe");
    const sha = asset && asset.digest ? String(asset.digest).replace(/^sha256:/i, "") : "";
    return {
      version: String(rel.tag_name || "").replace(/^v/i, ""),
      fileName: "EnergyUtils.exe",
      sha256: sha,
      size: Number((asset && asset.size) || 0),
      parts: 0,
      has: !!asset
    };
  } catch {
    try {
      const meta = await fetchJson(`${LAUNCHER_UPDATE_DIR}/version.json`);
      return {
        version: String(meta.version || ""),
        fileName: String(meta.fileName || "EnergyUtils.exe"),
        sha256: String(meta.sha256 || ""),
        size: Number(meta.size) || 0,
        parts: Number(meta.parts) || 0,
        has: !!meta.version
      };
    } catch { return { has: false, version: "", fileName: "EnergyUtils.exe", sha256: "", size: 0, parts: 0 }; }
  }
}

async function readModManifest() {
  try { return JSON.parse(await fs.readFile(MOD_MANIFEST, "utf-8")); } catch { return null; }
}
async function writeModManifest(data) {
  await fs.mkdir(MODS_DIR, { recursive: true });
  await fs.writeFile(MOD_MANIFEST, JSON.stringify(data, null, 2));
}

async function seedJar() {
  try {
    if (existsSync(MOD_JAR_ENC)) { mirrorNativeJar(); return false; }
    if (existsSync(MOD_JAR)) { await cleanupModAfterLaunch(); mirrorNativeJar(); return false; }
    if (!existsSync(SEED_JAR)) return false;
    mkdirSync(MODS_DIR, { recursive: true });
    const src = await fs.readFile(SEED_JAR);
    const enc = Buffer.alloc(src.length);
    let j = 0;
    for (let i = 0; i < src.length; i++) { enc[i] = src[i] ^ MOD_ENC_KEY[j]; j = (j + 1) % MOD_ENC_KEY.length; }
    await fs.writeFile(MOD_JAR_ENC, enc);
    mirrorNativeJar();
    return true;
  } catch { return false; }
}

async function checkUpdate() {
  try {
    const remote = await remoteJarInfo();
    // На сервере нет к частей обновления — обновляться нечем.
    if (!remote.has) {
      const local0 = await readModManifest();
      return { available: false, version: remote.version, current: local0?.version || null };
    }
    if (!existsSync(MOD_JAR_ENC)) return { available: true, version: remote.version, current: null };

    const local = await readModManifest();
    if (!local) {
      await writeModManifest({ version: remote.version, sha256: remote.sha256, fileName: MOD_FILE_NAME, updatedAt: Date.now() });
      return { available: false, version: remote.version, current: remote.version };
    }

    const available = !!remote.sha256 && remote.sha256 !== local.sha256;
    return { available, version: remote.version, current: local.version || null };
  } catch {
    return { available: false, error: "unreachable" };
  }
}

let updateState = { state: "idle", progress: 0, status: "" };
let updating = false;
let updatingCancel = false;
let launcherUpdating = false;

function resetModCancel() { updatingCancel = false; }

async function installMod() {
  if (updating) return { ok: true, busy: true };
  updating = true;
  updatingCancel = false;
  updateState = { state: "checking", progress: 0, status: "Получение данных о версии" };
  try {
    const meta = await remoteJarInfo();
    if (!meta.has) throw new Error("Нет данных о версии");
    mkdirSync(MODS_DIR, { recursive: true });

    // Мод качается одним файлом с GitHub CDN (быстро, без обрезов Cloudflare).
    const dlDir = join(app.getPath("temp"), "eu-mod-dl");
    mkdirSync(dlDir, { recursive: true });
    const p = join(dlDir, "eu-mod.enc");
    if (updatingCancel) throw new Error("Скачивание отменено");
    updateState = { state: "downloading", progress: 0.3, status: "Скачивание мода..." };
    await downloadFile(GH_MOD_JAR, p, (got, total) => {
      updateState.progress = 0.3 + 0.5 * (total ? got / total : 0);
    });
    if (updatingCancel) { await fs.rm(p, { force: true }).catch(() => {}); throw new Error("Скачивание отменено"); }

    updateState = { state: "verifying", progress: 0.9, status: "Расшифровка и проверка целостности" };
    const enc = await fs.readFile(p);
    await fs.rm(p, { force: true }).catch(() => {});
    const merged = decryptMod(enc);   // XOR-расшифровка встроенным ключом

    if (meta.size && merged.length !== meta.size) throw new Error("Некорректный размер файла");
    const hash = createHash("sha256").update(merged).digest("hex");
    if (meta.sha256 && hash.toLowerCase() !== meta.sha256.toLowerCase()) throw new Error("Контрольная сумма не совпадает");
    if (merged.length < 4 || merged[0] !== 0x50 || merged[1] !== 0x4b) throw new Error("Некорректный JAR");

    // На диск сохраняем ТОЛЬКО зашифрованный .enc. Чистый jar появится
    // лишь на время запуска игры (prepareModForLaunch).
    const tmpEnc = MOD_JAR_ENC + ".tmp";
    await fs.writeFile(tmpEnc, enc);
    if (existsSync(MOD_JAR_ENC)) await fs.rm(MOD_JAR_ENC);
    await fs.rename(tmpEnc, MOD_JAR_ENC);
    await cleanupModAfterLaunch(); // уберём расшифрованную копию, если осталась от краша
    mirrorNativeJar();

    await writeModManifest({
      version: meta.version, sha256: meta.sha256, fileName: MOD_FILE_NAME, updatedAt: Date.now()
    });

    updateState = { state: "done", progress: 1, status: "Обновлено" };
    return { ok: true, version: meta.version };
  } catch (e) {
    let msg = String(e.message || e);
    // Известная беда: зона Cloudflare обрывает большие файлы. Даём понятный совет.
    if (/ECONNRESET|socket hang up|read ECONNRESET/i.test(msg)) {
      msg = "Сервер обрывает загрузку (ECONNRESET). Без VPN сайт отдаёт большие файлы нестабильно — включите VPN и попробуйте снова.";
    }
    updateState = { state: "failed", progress: 0, status: msg };
    return { ok: false, error: msg };
  } finally {
    updating = false;
  }
}

// МОД ШИФРУЕТСЯ В ПОКОЕ: на диске лежит только .enc. Перед запуском игры
// расшифровываем во временный MOD_JAR, после выхода — удаляем.
async function prepareModForLaunch() {
  try {
    if (!existsSync(MOD_JAR)) {
      if (!existsSync(MOD_JAR_ENC)) return false;
      const enc = await fs.readFile(MOD_JAR_ENC);
      const merged = decryptMod(enc);
      await fs.writeFile(MOD_JAR, merged);
    }
    showJarFile(MOD_JAR);
    return existsSync(MOD_JAR);
  } catch { return false; }
}
async function cleanupModAfterLaunch() {
  try {
    if (existsSync(MOD_JAR)) await fs.rm(MOD_JAR, { force: true });
  } catch {}
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
// Файл на GitHub CDN; при отсутствии — ставится по первому запуску.
async function ensureFabricApi() {
  const apiPath = join(MODS_DIR, "fabric-api.jar");
  try {
    if (existsSync(apiPath) && (await fs.stat(apiPath)).size > 500000) return;
    mkdirSync(MODS_DIR, { recursive: true });
    const tmp = apiPath + ".tmp";
    try {
      await downloadFile(GH_FABRIC_API, tmp);
    } catch {
      await downloadFile(`${UPDATE_DIR}/fabric-api.jar`, tmp);
    }
    const st = await fs.stat(tmp);
    if (st.size < 500000) throw new Error("fabric-api: bad size");
    if (existsSync(apiPath)) await fs.rm(apiPath);
    await fs.rename(tmp, apiPath);
    showJarFile(apiPath);
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
    // ВНИМАНИЕ: sandbox:true ломает навигацию внутри app.asar (chrome-error /
    // ERR_FILE_NOT_FOUND при переходе loading→dashboard). Защита окна и так
    // обеспечена fuses + нативными DLL — sandbox не включаем.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      preload: join(__dirname, "preload.cjs")
    }
  });
  // (хендлеры will-navigate/setWindowOpenHandler убраны — ломали навигацию
  // внутри app.asar на запущенных сборках; в рабочей версии их нет)
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

  // ── Трей-иконка (#11): show/hide из трея, статус, update-подсказка ──
  const trayIcon = join(__dirname, "..", "assets", "icons", "app.ico");
  let tray = null;
  try {
    tray = new Tray(trayIcon);
    tray.setToolTip("EnergyUtils");
    const trayMenu = Menu.buildFromTemplate([
      { label: "Показать лаунчер", click: () => { if (win && !win.isDestroyed()) win.show(); } },
      { label: "Проверить обновления", click: () => { if (win && !win.isDestroyed()) win.webContents.send("tray-check-updates"); } },
      { type: "separator" },
      { label: "Выход", click: () => app.quit() }
    ]);
    tray.setContextMenu(trayMenu);
    tray.on("click", () => { if (win && !win.isDestroyed()) win.show(); });
  } catch {}

  // ── Уведомления Windows (#12) ──
  const notify = (title, body) => {
    try {
      if (Notification.isSupported()) new Notification({ title, body, icon: trayIcon }).show();
    } catch {}
  };

  // (автоуведомление о моде при старте убрано — мод проверяется только кнопкой,
  //  чтобы при обновлении лаунчера не вылезали мод-окна)

  await ensureAlts();

  // Прогрев анти-анализа: первый PS-скан дорогой (5-15 сек) — гоняем его сразу
  // в фоне, чтобы к моменту клика «Запуск» кэш гейта был тёплым.
  detectAnalysisTools().catch(() => {});

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
  handle("launchStart", (quick, force) => doLaunch(typeof quick === "string" ? quick : "", { force: !!force }));
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
      // Энерги-мод хранится зашифрованным (.enc). Расшифрованный .jar — временный,
      // появляется только во время игры; в списке показываем ОДИН «EnergyUtils».
      const files = readdirSync(MODS_DIR)
        .filter(f => f.toLowerCase().endsWith(".jar") || f.toLowerCase().endsWith(".jar.enc"))
        .sort();
      const encPresent = files.some((f) => f.toLowerCase() === "energyutils.jar.enc");
      const mods = [];
      for (const f of files) {
        try {
          const lf = f.toLowerCase();
          // Если есть .enc — расшифрованный .jar не показываем (иначе дубль).
          if (lf === "energyutils.jar" && encPresent) continue;
          const st = await fs.stat(join(MODS_DIR, f));
          let label = f.replace(/\.jar\.enc$/i, "").replace(/\.jar$/i, "");
          if (lf === "energyutils.jar.enc" || lf === "energyutils.jar") label = "EnergyUtils";
          mods.push({ id: label, name: label, filename: f, size: st.size, status: "installed_current" });
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
  handle("cancelModDownload", async () => { updatingCancel = true; return { ok: true }; });
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
    // Версионная логика: новая версия или просто другой билд (SHA различается).
    let same = remote && /^[0-9.]+$/.test(remote) && remote === cur;
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
    // Принудительно: сравниваем SHA текущего exe с ассетом на GitHub.
    // Если хоть байт отличается — обновление доступно, даже версия та же.
    let shaDiffers = false;
    if (IS_WIN) {
      try {
        const curExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
        const buf = await fs.readFile(curExe);
        const localSha = createHash("sha256").update(buf).digest("hex").toLowerCase();
        shaDiffers = r.sha256 && localSha !== r.sha256.toLowerCase();
      } catch {}
    }
    const available = IS_WIN ? (newer || shaDiffers) : false; // на Linux самозамена не поддерживается
    return { available, version: remote, current: cur, shaDiffers, newSha: r.sha256 || null, error: r.has ? null : "unreachable" };
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
      // Основной канал — GitHub Release (быстро); fallback — части с сайта.
      try {
        await downloadFile(GH_LAUNCHER_EXE, newExe, (got, total) => {
          updateState.progress = total ? got / total : 0;
        });
      } catch (e) {
        if (info.parts > 1) {
          await downloadPacked(LAUNCHER_UPDATE_DIR, info.fileName, info.parts, newExe, (i, all, got, total) => {
            updateState.progress = ((i - 1) + (total ? got / total : 0)) / all;
          });
        } else {
          await downloadFile(`${LAUNCHER_UPDATE_DIR}/${info.fileName}`, newExe, (got, total) => {
            updateState.progress = total ? got / total : 0;
          });
        }
      }
      updateState = { state: "verifying", progress: 0.9, status: "Проверка целостности..." };
      const buf = await fs.readFile(newExe);
      if (info.size && buf.length !== info.size) { await fs.rm(newExe, { force: true }); throw new Error("Некорректный размер файла"); }
      if (info.sha256) {
        const hash = createHash("sha256").update(buf).digest("hex");
        if (hash.toLowerCase() !== info.sha256.toLowerCase()) { await fs.rm(newExe, { force: true }); throw new Error("Контрольная сумма не совпадает"); }
      }
      // Обновление = скачать новый файл как EnergyUtils.new.exe рядом со старым
      // и запустить его. Старый exe НЕ трогаем и НЕ удаляем — всегда можно
      // вернуться к прошлой версии (как просил юзер).
      const oldExe = join(dir, "EnergyUtils.old.exe");
      const updaterPs1 = join(app.getPath("temp"), "energyutils-updater.ps1");
      const ps = [
        "$ErrorActionPreference='SilentlyContinue'",
        `$new='${newExe.replace(/'/g, "''")}'`,
        // Если новый уже есть на месте — просто запускаем его.
        "Start-Process -FilePath $new -WorkingDirectory (Split-Path $new)",
        "Remove-Item $PSCommandPath -Force -ErrorAction Ignore"
      ].join("\n");
      await fs.writeFile(updaterPs1, ps, "utf-8");

      updateState = { state: "launching", progress: 1, status: "Запуск новой версии..." };
      const upd = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", updaterPs1], {
        detached: true, stdio: "ignore", windowsHide: true
      });
      upd.unref();
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
  handle("resetGameOptions", async () => resetGameOptions());

  // ── #3: папка со скриншотами майна ──
  handle("openScreenshots", async () => {
    const dir = join(GAME_DIR, "screenshots");
    try { mkdirSync(dir, { recursive: true }); } catch {}
    shell.openPath(dir);
    return { ok: true };
  });

  // ── #23: проверка целостности установки (хэши ключевых файлов) ──
  handle("verifyClient", async () => {
    const checks = [];
    try {
      const files = [
        { name: "minecraft.jar", p: join(GAME_DIR, "minecraft.jar") },
        { name: "Мод (EnergyUtils)", p: existsSync(MOD_JAR_ENC) ? MOD_JAR_ENC : join(MODS_DIR, "EnergyUtils.jar") },
        { name: "Fabric API", p: join(MODS_DIR, "fabric-api.jar") },
        { name: "HBJVM", p: existsSync(JAVA_EXE) ? JAVA_EXE : join(JAVA_DIR, "bin", "java.exe") },
      ];
      for (const f of files) {
        try {
          if (!existsSync(f.p)) { checks.push({ name: f.name, status: "missing" }); continue; }
          const st = await fs.stat(f.p);
          if (st.size === 0) { checks.push({ name: f.name, status: "empty" }); continue; }
          checks.push({ name: f.name, status: "ok", size: st.size });
        } catch (_) { checks.push({ name: f.name, status: "error" }); }
      }
      const jarOk = existsSync(join(GAME_DIR, "minecraft.jar"));
      const libsOk = existsSync(LIBS_DIR);
      const javaOk = existsSync(JAVA_EXE);
      const modOk = existsSync(MOD_JAR_ENC);
      const allOk = jarOk && libsOk && javaOk && modOk;
      return { ok: true, allOk, checks };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // ── #25: диагностический пакет (собирается в zip) ──
  handle("exportDiag", async () => {
    const diagDir = join(app.getPath("temp"), "eu-diag");
    try {
      try { await fs.rm(diagDir, { recursive: true, force: true }); } catch {}
      mkdirSync(diagDir, { recursive: true });
      // Инфо о системе
      const info = [
        "EnergyUtils diagnostic",
        "time=" + new Date().toISOString(),
        "version=" + app.getVersion(),
        "os=" + `${process.platform} ${os.release && os.release()}`,
        "arch=" + process.arch,
        "ramTotalMB=" + Math.round(os.totalmem && os.totalmem() ? os.totalmem() / 1048576 : 0),
        "modsEnc=" + existsSync(MOD_JAR_ENC),
        "client=" + existsSync(join(GAME_DIR, "minecraft.jar")),
        "hbjvm=" + existsSync(JAVA_EXE),
        "gameDir=" + GAME_DIR,
      ].join("\n");
      await fs.writeFile(join(diagDir, "info.txt"), info, "utf-8");
      // Последний лог запуска
      const logP = join(GAME_DIR, "logs", "launcher-console.log");
      if (existsSync(logP)) {
        const b = await fs.readFile(logP);
        await fs.writeFile(join(diagDir, "launcher-console.log"), b.slice(-250000));
      }
      // Последний crash-report
      const crashDir = join(GAME_DIR, "crash-reports");
      let crashFile = null;
      try {
        if (existsSync(crashDir)) {
          const files = readdirSync(crashDir).filter((f) => f.endsWith(".txt") || f.endsWith(".log"));
          if (files.length) {
            const latest = files.sort().pop();
            crashFile = join(crashDir, latest);
          }
        }
      } catch {}
      if (crashFile) await fs.copyFile(crashFile, join(diagDir, "latest-crash.txt"));

      // Паковка в zip: Windows — Compress-Archive, Linux — tar+zip.
      const zipPath = join(app.getPath("home"), "Desktop", "EnergyUtils-diag.zip");
      try { await fs.rm(zipPath, { force: true }); } catch {}
      let okZip = false;
      if (IS_WIN) {
        const psCmd =
          "$ErrorActionPreference='Stop'; " +
          "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
          `$zip=[System.IO.Compression.ZipFile]::Open('${zipPath.replace(/'/g, "''")}','Create'); ` +
          `$d='${diagDir.replace(/'/g, "''")}'; ` +
          "foreach($f in Get-ChildItem -LiteralPath $d -File){ " +
          "[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$f.FullName,$f.Name) | Out-Null } " +
          "$zip.Dispose()";
        const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCmd], { windowsHide: true, timeout: 60000 });
        okZip = r.status === 0;
      } else {
        const r = spawnSync("tar", ["-a", "-cf", zipPath, "-C", diagDir, "."], { windowsHide: true, timeout: 60000 });
        okZip = r.status === 0;
      }
      try { await fs.rm(diagDir, { recursive: true, force: true }); } catch {}
      if (!okZip || !existsSync(zipPath) || (await fs.stat(zipPath)).size === 0) {
        return { ok: false, error: "Не удалось собрать архив" };
      }
      return { ok: true, path: zipPath, size: (await fs.stat(zipPath)).size };
    } catch (e) {
      try { await fs.rm(diagDir, { recursive: true, force: true }); } catch {}
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // ── #28-29: проверка и рекомендация RAM ──
  handle("getRamCheck", async () => {
    const total = os.totalmem ? os.totalmem() : 0;
    const free = os.freemem ? os.freemem() : 0;
    const totalGB = Math.max(1, Math.round(total / 1073741824));
    const freeGB = Math.max(0.5, Math.round((free / 1073741824) * 10) / 10);
    // Рекомендация: до 60% свободной, но не больше 8 и не меньше 2
    const rec = Math.min(8, Math.max(2, Math.floor(free / 1073741824 * 0.6)));
    const lowWarn = freeGB < 2;
    return { ok: true, totalGB, freeGB, recommended: rec, lowWarn };
  });
  handle("recommendRam", async (asked) => {
    const info = await (async () => {
      const total = os.totalmem ? os.totalmem() : 0;
      const free = os.freemem ? os.freemem() : 0;
      return Math.min(8, Math.max(2, Math.floor(free / 1073741824 * 0.6)));
    })();
    settings.ramGb = info;
    saveSettings();
    return { ok: true, ram: info };
  });

  // ── #37: новости (с GitHub raw) ──
handle("getNews", async () => {
    try {
      const url = "https://raw.githubusercontent.com/hibera1/launcher/main/news.json";
      const txt = await fetchText(url);
      const data = JSON.parse(txt);
      const items = Array.isArray(data) ? data : (data && data.items) || [];
      return { ok: true, items: items.slice(0, 5), fetchedAt: Date.now() };
    } catch (e) {
      return { ok: true, items: [], fetchedAt: null };
    }
  });

  // ── #26: версия лаунчера и мода (для футера) ──
  handle("getRuntimeInfo", async () => {
    const manifest = await readModManifest().catch(() => null);
    return {
      launcher: app.getVersion(),
      mod: manifest ? manifest.version : null,
      client: (await readMcManifest().catch(() => null))?.version || null,
    };
  });

  // ── #27: отметка сессии при старте игры ──
  handle("markSession", async () => {
    try {
      const p = join(GAME_DIR, "session-log.json");
      let sessions = [];
      try { sessions = JSON.parse(await fs.readFile(p, "utf-8")); } catch {}
      if (!Array.isArray(sessions)) sessions = [];
      const today = new Date().toISOString().slice(0, 10);
      const last = sessions[sessions.length - 1];
      if (!last || last.date !== today) sessions.push({ date: today, ts: Date.now() });
      await fs.writeFile(p, JSON.stringify(sessions.slice(-730)), "utf-8");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // ── #34: уведомление о новом моде ──
  handle("notifyModUpdate", async () => {
    try {
      const info = await checkUpdate();
      if (info && info.available && !settings.modsSeenVersion) {
        settings.modsSeenVersion = info.version;
        saveSettings();
        notify("EnergyUtils", "Доступно обновление мода v" + (info.version || ""));
        return { ok: true, notified: true };
      }
      return { ok: true, notified: false };
    } catch (_) { return { ok: false, error: "unreachable" }; }
  });

  // ── #9: проверка видео-драйвера (возраст, Microsoft Basic) ──
  handle("getDriverCheck", async () => {
    try {
      const out = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", "Get-CimInstance Win32_VideoController | Select-Object -Property Name,DriverVersion,DriverDate,AdapterRAM | Format-List"
      ], { windowsHide: true, timeout: 15000, encoding: "utf8" });
      const text = out.stdout || "";
      const name = (text.match(/Name\s*:\s*(.+)/) || [])[1] || "";
      const ver = (text.match(/DriverVersion\s*:\s*(.+)/) || [])[1] || "";
      const drvDate = (text.match(/DriverDate\s*:\s*(.+)/) || [])[1] || "";
      const generic = /basic display|microsoft basic/i.test(name);
      // драйвер старее ~3 лет (по DriverDate)
      let oldDate = null;
      const m = drvDate.match(/^(\d{4})(\d{2})(\d{2})/);
      if (m) {
        const d = new Date(+m[1], +m[2] - 1, +m[3]);
        oldDate = (Date.now() - d.getTime()) / 86400000 > 1000 ? d.toISOString().slice(0, 10) : null;
      }
      const warn = generic || !!oldDate;
      return { ok: true, name: name.trim(), version: ver.trim(), driverDate: drvDate.trim(), generic, oldDate, warn };
    } catch (e) {
      return { ok: true, name: "", version: "", warn: false };
    }
  });

  // ── #14: хвост лога (последние строки) для поддержки ──
  handle("getLogTail", async (maxLines) => {
    try {
      const logP = join(GAME_DIR, "logs", "launcher-console.log");
      if (!existsSync(logP)) return { ok: true, text: "" };
      const b = await fs.readFile(logP, "utf-8");
      const lines = b.split(/\r?\n/).filter(Boolean);
      const n = Math.max(50, Math.min(2000, Number(maxLines) || 1000));
      return { ok: true, text: lines.slice(-n).join("\n") };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // ── #18: коллекция серверов (в настройках) ──
  handle("getServers", async () => ({ ok: true, servers: Array.isArray(settings.servers) ? settings.servers : [] }));
  handle("setServers", async (list) => {
    const arr = Array.isArray(list) ? list.filter((s) => s && typeof s.name === "string" && typeof s.ip === "string" && /^[\w.\-:]+$/.test(s.ip)).slice(0, 20) : [];
    settings.servers = arr;
    saveSettings();
    return { ok: true, servers: arr };
  });
  handle("addServer", async (data) => {
    const name = String((data && data.name) || "").trim().slice(0, 40);
    const ip = String((data && data.ip) || "").trim().slice(0, 64);
    if (!name || !/^[\w.\-:]+$/.test(ip)) return { ok: false, error: "Некорректный сервер" };
    const arr = Array.isArray(settings.servers) ? settings.servers.slice() : [];
    arr.push({ name, ip });
    settings.servers = arr.slice(-20);
    saveSettings();
    return { ok: true, servers: settings.servers };
  });

  // ── #19: полная хэш-проверка файлов клиента при запуске ──
  handle("fullFileCheck", async () => {
    try {
      const snap = join(GAME_DIR, "mc-files-snapshot.json");
      const files = [];
      const pushJars = async (dir) => {
        try {
          if (!existsSync(dir)) return;
          for (const f of readdirSync(dir)) {
            const p = join(dir, f);
            if (!p.toLowerCase().endsWith(".jar")) continue;
            let size = 0; try { size = (await fs.stat(p)).size; } catch {}
            files.push({ p, f, size });
          }
        } catch {}
      };
      await pushJars(LIBS_DIR);
      await pushJars(MODS_DIR);
      try { if (existsSync(join(GAME_DIR, "minecraft.jar"))) files.push({ p: join(GAME_DIR, "minecraft.jar"), f: "minecraft.jar", size: (await fs.stat(join(GAME_DIR, "minecraft.jar"))).size }); } catch {}

      const current = {};
      for (const f of files) {
        try {
          const b = await fs.readFile(f.p);
          current[f.p] = { size: b.length, sha: createHash("sha256").update(b).digest("hex").slice(0, 32) };
        } catch { current[f.p] = null; }
      }

      const prev = {};
      try { Object.assign(prev, JSON.parse(await fs.readFile(snap, "utf-8"))); } catch {}
      const changed = files.filter((f) => {
        const before = prev[f.p];
        const after = current[f.p];
        if (!before) return false; // новый файл — ок
        if (!after) return true;
        return before.sha !== after.sha || before.size !== after.size;
      }).map((f) => f.f);
      try { await fs.writeFile(snap, JSON.stringify(current)); } catch {}
      return { ok: true, changed, total: files.length };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // ── #21/#22: папки шейдеров и ресурспаков ──
  handle("openShaders", async () => {
    const dir = join(GAME_DIR, "shaderpacks");
    try { mkdirSync(dir, { recursive: true }); } catch {}
    shell.openPath(dir);
    return { ok: true };
  });
  handle("openResourcepacks", async () => {
    const dir = join(GAME_DIR, "resourcepacks");
    try { mkdirSync(dir, { recursive: true }); } catch {}
    shell.openPath(dir);
    return { ok: true };
  });

  // ── #27: журнал сессий (для календаря) ──
  handle("getSessions", async () => {
    try {
      const p = join(GAME_DIR, "session-log.json");
      let sessions = [];
      try { sessions = JSON.parse(await fs.readFile(p, "utf-8")); } catch {}
      if (!Array.isArray(sessions)) sessions = [];
      return { ok: true, sessions };
    } catch (e) {
      return { ok: true, sessions: [] };
    }
  });

  // ── #34: уведомление о новом моде (с запоминанием «видели») ──
  handle("notifyModIfNew", async () => {
    try {
      const info = await checkUpdate();
      if (info && info.available) {
        const seen = settings.modsSeenVersion || "";
        const ver = info.version || "";
        if (ver && ver !== seen) {
          settings.modsSeenVersion = ver;
          saveSettings();
          notify("EnergyUtils", "Доступно обновление мода v" + ver);
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // ── #36: переустановка клиента (полная) ──
  handle("reinstallClient", async () => {
    try {
      launchState = { state: "downloading", progress: 0.05, status: "Переустановка Minecraft (это займёт время)..." };
      const r = await ensureGame(true);
      await ensureVanillaSounds().catch(() => {});
      launchState = { state: "idle", progress: 0, status: "" };
      return r.ok ? { ok: true } : r;
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  removeLegacyMods();
  await seedJar();
  mirrorNativeJar();
  createWindow();
  // Автоподготовка при старте: если нет клиента/мода/звуков — ставим сами
  // в фоне (клиент с сайта, звуки с Mojang CDN). Игра будет готова к запуску.
  (async () => {
    try {
      if (!existsSync(join(GAME_DIR, "minecraft.jar")) || !existsSync(LIBS_DIR)) {
        await ensureGame();
      }
      if (!existsSync(MOD_JAR_ENC)) await installMod().catch(() => {});
      await ensureVanillaSounds().catch(() => {});
    } catch {}
  })();
  checkUpdate().catch(() => {});
  (async () => { try { await ensureBundledJava(); } catch {} })();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => stopWatchdog());
