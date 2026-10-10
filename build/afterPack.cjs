// After-pack hook: Fuses → VERSION-ресурс (EnergyStudio / by HB) → подпись
// внутреннего exe. Внешний portable-стаб подписывается отдельным шагом после
// сборки (sign-portable.cmd / signtool).
// ВАЖНО: всё, что ниже — только для Windows (.exe). Linux-сборка пропускается.
const path = require("path");
const { execFileSync } = require("child_process");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

exports.default = async function (context) {
  if (!context.packager.platform || (context.packager.platform.name || "").toLowerCase() !== "windows") {
    console.log("[afterPack] Linux/macOS — пропуск (fuses/sign только для Windows)");
    return;
  }
  const exe = path.join(context.appOutDir, "EnergyUtils.exe");

  // 1) Fuses
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,                               // нельзя как node
    [FuseV1Options.EnableCookieEncryption]: true,                   // шифруем куки
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,    // блок NODE_OPTIONS
    [FuseV1Options.EnableNodeCliInspectArguments]: false,           // блок --inspect
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,   // в portable недоступна
    // OnlyLoadAppFromAsar:true И GrantFileProtocolExtraPrivileges:false ЛОМАЮТ
    // навигацию loading→dashboard внутри app.asar (ERR_FILE_NOT_FOUND) —
    // оба оставляем дефолтными (false / true).
    // [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  });
  console.log("[fuses] hardening applied:", exe);

  // 2) VERSION-ресурс: издатель EnergyStudio, автор HB
  try {
    const cache = process.env.LOCALAPPDATA + "\\electron-builder\\Cache\\winCodeSign";
    const rceditDirs = require("fs").readdirSync(cache);
    let rcedit = null;
    for (const d of rceditDirs) {
      const cand = path.join(cache, d, "rcedit-x64.exe");
      if (require("fs").existsSync(cand)) { rcedit = cand; break; }
    }
    if (rcedit) {
      execFileSync(rcedit, [
        exe,
        "--set-version-string", "CompanyName", "EnergyStudio",
        "--set-version-string", "FileDescription", "EnergyUtils Launcher by HB",
        "--set-version-string", "LegalCopyright", "© 2026 EnergyStudio",
        "--set-version-string", "ProductName", "EnergyUtils",
        "--set-version-string", "OriginalFilename", "EnergyUtils.exe",
        "--set-version-string", "InternalName", "EnergyUtils",
      ], { stdio: "ignore" });
      console.log("[version] publisher metadata applied");
    }
  } catch (e) {
    console.warn("[version] rcedit skipped:", String(e.message || e).slice(0, 120));
  }

  // 3) Подпись внутреннего exe (самоподписанный EnergyStudio)
  try {
    const pfx = process.env.EU_SIGN_PFX;
    const pw = process.env.EU_SIGN_PW;
    if (pfx && pw) {
      const signtool = "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.17763.0\\x64\\signtool.exe";
      execFileSync(signtool, [
        "sign", "/f", pfx, "/p", pw, "/fd", "SHA256",
        "/tr", "http://timestamp.digicert.com", "/td", "SHA256", exe,
      ], { stdio: "ignore" });
      console.log("[sign] inner exe signed");
    } else {
      console.log("[sign] EU_SIGN_PFX/EU_SIGN_PW not set — inner exe unsigned");
    }
  } catch (e) {
    console.warn("[sign] skipped:", String(e.message || e).slice(0, 160));
  }
};