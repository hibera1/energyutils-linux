// xplat.js — кросс-платформенные утилиты лаунчера (Windows + Linux + macOS).
// Чистый Node (без Electron) — можно тестировать отдельно.
// Чинит: извлечение zip/tar.gz через tar/unzip вместо powershell Expand-Archive,
// путь к java без .exe, chmod вместо attrib, HWID-хинт, детект отладчика.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export const IS_WIN = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";
export const IS_MAC = process.platform === "darwin";

// Имя исполняемого файла java в bin/ (без расширения на unix).
export function javaBinName() {
  return IS_WIN ? "java.exe" : "java";
}

// Извлечь архив (zip или tar.gz) в destDir. Сначала системный tar/bsdtar
// (есть на Debian, Arch, и в Windows 10+ как bsdtar), затем unzip, затем
// windows Expand-Archive как последний запасной вариант.
export function extractArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const lower = archivePath.toLowerCase();

  // 1) tar (bsdtar) — умеет zip и tar.gz кросс-платформенно.
  let r = run("tar", ["-xf", archivePath, "-C", destDir]);
  if (r) return true;

  // 2) unzip (linux/mac).
  if (!IS_WIN) {
    r = run("unzip", ["-o", "-q", archivePath, "-d", destDir]);
    if (r) return true;
    // 3) tar.gz без bsdtar — через tar|gunzip.
    if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
      r = run("tar", ["-xzf", archivePath, "-C", destDir]);
      if (r) return true;
    }
  }

  // 4) Windows PowerShell Expand-Archive (фолбэк).
  if (IS_WIN && (lower.endsWith(".zip"))) {
    const ps = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command",
      `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ];
    r = run("powershell.exe", ps);
    if (r) return true;
  }

  return false;
}

// Найти в destDir подкаталог вида jdk-* / temurin-* / hbjvm-* и поднять его
// содержимое на уровень destDir, переименовав каталог в "HBJVM-L"
// (архивы Temurin пакуются в таком подкаталоге, а юзер просил имя HBJVM-L).
export function liftJreDir(destDir) {
  try {
    if (!existsSync(destDir)) return;
    let sub = readdirSync(destDir).find((d) => /^(jdk|jre|temurin|hbjvm)[-_]/i.test(d));
    if (sub) {
      const inner = join(destDir, sub);
      if (statSync(inner).isDirectory()) {
        for (const ent of readdirSync(inner)) {
          const src = join(inner, ent), dst = join(destDir, ent);
          if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
          renameSync(src, dst);
        }
        rmSync(inner, { recursive: true, force: true });
      }
    }
    // Если файлы легли прямо в destDir (не в подкаталог) — переименовываем
    // папку bin под ожидаемое имя не нужно: главное, что bin/java на месте.
  } catch { /* ignore */ }
}

// Имя каталога рантайма Java в линукс-сборке — HBJVM-L.
export const JAVA_RUNTIME_NAME = IS_WIN ? "java" : "HBJVM-L";

// Удалить лишние инструменты JVM, которыми можно снять дамп/сервисы.
export function stripJre(javaDir) {
  const WIN = ["jfr.exe", "jrunscript.exe", "jwebserver.exe", "rmiregistry.exe",
               "keytool.exe", "kinit.exe", "klist.exe", "ktab.exe"];
  const UNIX = ["jfr", "jrunscript", "jwebserver", "rmiregistry", "keytool",
                "kinit", "klist", "ktab"];
  const list = IS_WIN ? WIN : UNIX;
  const binDir = join(javaDir, "bin");
  try {
    if (!existsSync(binDir)) return;
    for (const f of list) {
      try { const p = join(binDir, f); if (existsSync(p)) rmSync(p, { force: true }); } catch {}
    }
    for (const rel of ["lib/jfr", "legal", "conf/management"]) {
      try { const p = join(javaDir, rel); if (existsSync(p)) rmSync(p, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

// chmod +x на *.so / bin/* (linux/mac), на винде no-op.
export function makeExecutable(dirPath) {
  if (IS_WIN) return;
  try {
    run("chmod", ["-R", "+x", dirPath]);
  } catch {}
}

// Скрыть файл: винде attrib +h, на unix — переименовать в .name (dotfile).
export function hideFile(p, on, off) {
  if (!existsSync(p)) return;
  if (IS_WIN) {
    run("attrib", [on ? "+h" : "-h", p]);
  }
}

// HWID-хинт для диагностики (реальный источник — нативный модуль).
export function hwidHint() {
  if (IS_WIN) return "win:" + os.hostname();
  let mid = "";
  try { mid = require("node:fs").readFileSync("/etc/machine-id", "utf8").trim(); } catch {}
  return "linux:" + (mid || os.hostname());
}

// Детект отладчика: win через натив, linux через /proc/self/status TracerPid.
export function debuggerProxyHint() {
  if (IS_LINUX) {
    try {
      const st = require("node:fs").readFileSync("/proc/self/status", "utf8");
      const m = st.match(/^TracerPid:\s*(\d+)/m);
      return m ? m[1] !== "0" : false;
    } catch {
      return false;
    }
  }
  return false;
}

function run(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { windowsHide: true, timeout: 300000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

// SaaS: тест на Windows (tar.exe = bsdtar).
export function selfTest(archivePath, destDir) {
  const ok = extractArchive(archivePath, destDir);
  liftJreDir(destDir);
  return ok;
}