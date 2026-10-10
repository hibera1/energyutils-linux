// Обфускация ESM/CJS файлов лаунчера через javascript-obfuscator.
// Безопасный профиль: stringArray + hex-имена, БЕЗ control flow flattening,
// selfDefending, deadCode — чтобы не сломать Electron/ESM/import.meta.
const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const ROOT = path.join(__dirname, "..");
const SRC = "electron";
const DST = "electron-obf";
// preload.cjs НЕ обфусцируем (работает в sandbox-окружении рендера,
// где обфусцированный код с stringArray может упасть — UI не встанет).
// В нём нет секретов: только contextBridge.exposeInMainWorld.
const FILES = ["main.js", "antiAnalysis.js"];
const COPY_VERBATIM = ["preload.cjs"];

const baseOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  stringArray: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ["base64"],
  rotateStringArray: true,
  shuffleStringArray: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  unicodeEscapeSequence: false,
  simplify: true,
  splitStrings: false,
  numbersToExpressions: false,
  transformObjectKeys: false,
  debugProtection: false,
  disableConsoleOutput: false,
  log: false,
  ignoreImports: true,       // import/require не трогаем
  transformPrivateProperties: false,
};

fs.mkdirSync(path.join(ROOT, DST), { recursive: true });
for (const f of COPY_VERBATIM) {
  fs.copyFileSync(path.join(ROOT, SRC, f), path.join(ROOT, DST, f));
  console.log("copied as-is:", f);
}
for (const f of FILES) {
  const src = fs.readFileSync(path.join(ROOT, SRC, f), "utf8");
  const sourceType = f.endsWith(".cjs") ? "script" : "module";
  const options = { ...baseOptions, sourceType };
  const out = JavaScriptObfuscator.obfuscate(src, options).getObfuscatedCode();
  fs.writeFileSync(path.join(ROOT, DST, f), out, "utf8");
  const kbytes = (out.length / 1024).toFixed(1);
  console.log("obfuscated:", f, "-", kbytes, "KB");
}
console.log("done ->", path.join(ROOT, DST));