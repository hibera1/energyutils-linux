// antiAnalysisShim.mjs — кроссплатформенная обёртка над антианализом.
// На Windows использует настоящий antiAnalysis.js; на Linux/macOS даёт
// безопасные заглушки (без PS-скана и Windows API), чтобы лаунчер
// не падал при старте. Watchdog на Linux по-прежнему следит за процессами.
const isWin = process.platform === "win32";

let real = null;
if (isWin) {
  try {
    real = await import("./antiAnalysis.js");
  } catch {
    real = null;
  }
}

export function detectAnalysisTools() {
  if (real && real.detectAnalysisTools) {
    try { return real.detectAnalysisTools(); } catch { return []; }
  }
  return [];
}

export function gateSummary(hits) {
  if (real && real.gateSummary) {
    try { return real.gateSummary(hits); } catch { return ""; }
  }
  return "антианализ недоступен на этой платформе";
}

export function startWatchdog(...args) {
  if (real && real.startWatchdog) {
    try { return real.startWatchdog(...args); } catch { return undefined; }
  }
  return undefined;
}

export function stopWatchdog(...args) {
  if (real && real.stopWatchdog) {
    try { return real.stopWatchdog(...args); } catch { return undefined; }
  }
  return undefined;
}

export default { detectAnalysisTools, gateSummary, startWatchdog, stopWatchdog };