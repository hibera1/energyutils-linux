const { contextBridge, ipcRenderer } = require("electron");

function call(name) {
  return (...args) => ipcRenderer.invoke("native:" + name, ...args);
}

const native = {
  ready: call("ready"),
  hide: call("hide"),
  close: call("close"),
  dragMove: call("dragMove"),
  copyToClipboard: call("copyToClipboard"),
  openUrl: call("openUrl"),
  openFolder: call("openFolder"),
  browseFolder: call("browseFolder"),
  openUserMods: call("openUserMods"),
  openManualUpdate: call("openManualUpdate"),

  authState: call("authState"),
  authTryRestore: call("authTryRestore"),
  authStart: call("authStart"),
  authLogout: call("authLogout"),
  fetchAvatar: call("fetchAvatar"),
  stashCache: call("stashCache"),
  startMicrosoftLogin: call("startMicrosoftLogin"),
  microsoftLoginStatus: call("microsoftLoginStatus"),
  cancelMicrosoftLogin: call("cancelMicrosoftLogin"),
  getAccounts: call("getAccounts"),
  addAccount: call("addAccount"),
  removeAccount: call("removeAccount"),
  getSelectedAccount: call("getSelectedAccount"),
  setSelectedAccount: call("setSelectedAccount"),

  getVersions: call("getVersions"),
  getSelectedVersion: call("getSelectedVersion"),
  setSelectedVersion: call("setSelectedVersion"),
  launchStart: call("launchStart"),
  launchCancel: call("launchCancel"),
  launchProgress: call("launchProgress"),
  getSystemRam: call("getSystemRam"),
  setRam: call("setRam"),
  setGameDir: call("setGameDir"),
  getSettings: call("getSettings"),
  getShowQuickLaunch: call("getShowQuickLaunch"),
  setShowQuickLaunch: call("setShowQuickLaunch"),

  listMods: call("listMods"),
  downloadMod: call("downloadMod"),
  deleteMod: call("deleteMod"),
  installGame: call("installGame"),
  gameStatus: call("gameStatus"),

  checkLauncherUpdate: call("checkLauncherUpdate"),
  checkModUpdate: call("checkModUpdate"),
  startLauncherUpdate: call("startLauncherUpdate"),
  updateProgress: call("updateProgress"),

  getDevConsole: call("getDevConsole"),
  setDevConsole: call("setDevConsole"),
  getDevToolsInfo: call("getDevToolsInfo"),
  openLogsFolder: call("openLogsFolder"),
  openCrashFolder: call("openCrashFolder"),
  resetGameOptions: call("resetGameOptions"),
  openScreenshots: call("openScreenshots"),
  verifyClient: call("verifyClient"),
  exportDiag: call("exportDiag"),
  getRamCheck: call("getRamCheck"),
  recommendRam: call("recommendRam"),
  getNews: call("getNews"),
  getDriverCheck: call("getDriverCheck"),
  getLogTail: call("getLogTail"),
  getServers: call("getServers"),
  setServers: call("setServers"),
  addServer: call("addServer"),
  fullFileCheck: call("fullFileCheck"),
  openShaders: call("openShaders"),
  openResourcepacks: call("openResourcepacks"),
  getSessions: call("getSessions"),
  markSession: call("markSession"),
  notifyModUpdate: call("notifyModUpdate"),
  reinstallClient: call("reinstallClient"),
  getRuntimeInfo: call("getRuntimeInfo")
};

contextBridge.exposeInMainWorld("nativeReady", native.ready);
contextBridge.exposeInMainWorld("nativeHide", native.hide);
contextBridge.exposeInMainWorld("nativeClose", native.close);
contextBridge.exposeInMainWorld("nativeDragMove", native.dragMove);
contextBridge.exposeInMainWorld("nativeCopyToClipboard", native.copyToClipboard);
contextBridge.exposeInMainWorld("nativeOpenUrl", native.openUrl);
contextBridge.exposeInMainWorld("nativeOpenFolder", native.openFolder);
contextBridge.exposeInMainWorld("nativeBrowseFolder", native.browseFolder);
contextBridge.exposeInMainWorld("nativeOpenUserMods", native.openUserMods);
contextBridge.exposeInMainWorld("nativeOpenManualUpdate", native.openManualUpdate);

contextBridge.exposeInMainWorld("nativeAuthState", native.authState);
contextBridge.exposeInMainWorld("nativeAuthTryRestore", native.authTryRestore);
contextBridge.exposeInMainWorld("nativeAuthStart", native.authStart);
contextBridge.exposeInMainWorld("nativeAuthLogout", native.authLogout);
contextBridge.exposeInMainWorld("nativeFetchAvatar", native.fetchAvatar);
contextBridge.exposeInMainWorld("nativeStashCache", native.stashCache);
contextBridge.exposeInMainWorld("nativeStartMicrosoftLogin", native.startMicrosoftLogin);
contextBridge.exposeInMainWorld("nativeMicrosoftLoginStatus", native.microsoftLoginStatus);
contextBridge.exposeInMainWorld("nativeCancelMicrosoftLogin", native.cancelMicrosoftLogin);
contextBridge.exposeInMainWorld("nativeGetAccounts", native.getAccounts);
contextBridge.exposeInMainWorld("nativeAddAccount", native.addAccount);
contextBridge.exposeInMainWorld("nativeRemoveAccount", native.removeAccount);
contextBridge.exposeInMainWorld("nativeGetSelectedAccount", native.getSelectedAccount);
contextBridge.exposeInMainWorld("nativeSetSelectedAccount", native.setSelectedAccount);

contextBridge.exposeInMainWorld("nativeGetVersions", native.getVersions);
contextBridge.exposeInMainWorld("nativeGetSelectedVersion", native.getSelectedVersion);
contextBridge.exposeInMainWorld("nativeSetSelectedVersion", native.setSelectedVersion);
contextBridge.exposeInMainWorld("nativeLaunchStart", native.launchStart);
contextBridge.exposeInMainWorld("nativeLaunchCancel", native.launchCancel);
contextBridge.exposeInMainWorld("nativeLaunchProgress", native.launchProgress);
contextBridge.exposeInMainWorld("nativeGetSystemRam", native.getSystemRam);
contextBridge.exposeInMainWorld("nativeSetRam", native.setRam);
contextBridge.exposeInMainWorld("nativeSetGameDir", native.setGameDir);
contextBridge.exposeInMainWorld("nativeGetSettings", native.getSettings);
contextBridge.exposeInMainWorld("nativeGetShowQuickLaunch", native.getShowQuickLaunch);
contextBridge.exposeInMainWorld("nativeSetShowQuickLaunch", native.setShowQuickLaunch);

contextBridge.exposeInMainWorld("nativeListMods", native.listMods);
contextBridge.exposeInMainWorld("nativeDownloadMod", native.downloadMod);
contextBridge.exposeInMainWorld("nativeDeleteMod", native.deleteMod);
contextBridge.exposeInMainWorld("nativeInstallGame", native.installGame);
contextBridge.exposeInMainWorld("nativeGameStatus", native.gameStatus);

contextBridge.exposeInMainWorld("nativeCheckLauncherUpdate", native.checkLauncherUpdate);
contextBridge.exposeInMainWorld("nativeCheckModUpdate", native.checkModUpdate);
contextBridge.exposeInMainWorld("nativeStartLauncherUpdate", native.startLauncherUpdate);
contextBridge.exposeInMainWorld("nativeUpdateProgress", native.updateProgress);

contextBridge.exposeInMainWorld("nativeGetDevConsole", native.getDevConsole);
contextBridge.exposeInMainWorld("nativeSetDevConsole", native.setDevConsole);
contextBridge.exposeInMainWorld("nativeGetDevToolsInfo", native.getDevToolsInfo);
contextBridge.exposeInMainWorld("nativeOpenLogsFolder", native.openLogsFolder);
contextBridge.exposeInMainWorld("nativeOpenCrashFolder", native.openCrashFolder);
contextBridge.exposeInMainWorld("nativeResetGameOptions", native.resetGameOptions);
contextBridge.exposeInMainWorld("nativeOpenScreenshots", native.openScreenshots);
contextBridge.exposeInMainWorld("nativeVerifyClient", native.verifyClient);
contextBridge.exposeInMainWorld("nativeExportDiag", native.exportDiag);
contextBridge.exposeInMainWorld("nativeGetRamCheck", native.getRamCheck);
contextBridge.exposeInMainWorld("nativeRecommendRam", native.recommendRam);
contextBridge.exposeInMainWorld("nativeGetNews", native.getNews);
contextBridge.exposeInMainWorld("nativeGetDriverCheck", native.getDriverCheck);
contextBridge.exposeInMainWorld("nativeGetLogTail", native.getLogTail);
contextBridge.exposeInMainWorld("nativeGetServers", native.getServers);
contextBridge.exposeInMainWorld("nativeSetServers", native.setServers);
contextBridge.exposeInMainWorld("nativeAddServer", native.addServer);
contextBridge.exposeInMainWorld("nativeFullFileCheck", native.fullFileCheck);
contextBridge.exposeInMainWorld("nativeOpenShaders", native.openShaders);
contextBridge.exposeInMainWorld("nativeOpenResourcepacks", native.openResourcepacks);
contextBridge.exposeInMainWorld("nativeGetSessions", native.getSessions);
contextBridge.exposeInMainWorld("nativeMarkSession", native.markSession);
contextBridge.exposeInMainWorld("nativeNotifyModUpdate", native.notifyModUpdate);
contextBridge.exposeInMainWorld("nativeReinstallClient", native.reinstallClient);
contextBridge.exposeInMainWorld("nativeGetRuntimeInfo", native.getRuntimeInfo);

// События из main (трей и т.п.)
contextBridge.exposeInMainWorld("nativeOnTrayCheckUpdates", (cb) => {
  ipcRenderer.on("tray-check-updates", () => { try { cb && cb(); } catch (_) {} });
});
