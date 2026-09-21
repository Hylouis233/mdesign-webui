/**
 * mdesign-webui 浏览器 shim —— 替代桌面版 preload（contextBridge）暴露的
 * window.hilo / 环境全局。必须先于渲染端 bundle 执行（由 mdesign-webui.mjs
 * 注入到 index.html <head> 顶部）。
 *
 * 原则：
 *  - ipcRenderer.invoke 记录到 console.debug 并返回 undefined 的 Promise，
 *    让 ProxyChannel 服务优雅降级而不是崩溃；
 *  - auth.getTokens/getUser 从 gateway 的 /api/auth/token 取登录态
 *    （桌面版由 Electron 主进程持久化，webui 版由 mdesign-webui 播种）；
 *  - 其余桌面能力（窗口控制/通知/对话框）全部可安全 no-op。
 */
(function () {
  "use strict";
  if (window.__HILO_SHIM_APPLIED__) return;

  var consoleDebug = console.debug.bind(console);
  function debug() {
    try { consoleDebug.apply(console, ["[mweb-shim]"].concat([].slice.call(arguments))); } catch (e) {}
  }

  // ---- ipcRenderer ----
  var channelListeners = new Map();
  function on(channel, listener) {
    if (!channelListeners.has(channel)) channelListeners.set(channel, new Set());
    channelListeners.get(channel).add(listener);
    return function off() {
      var s = channelListeners.get(channel);
      if (s) s.delete(listener);
    };
  }
  var ipcRenderer = {
    send: function (channel) { debug("send", channel); },
    invoke: function (channel) {
      debug("invoke", channel);
      return Promise.resolve(undefined);
    },
    on: on,
    removeListener: function (channel, listener) {
      var s = channelListeners.get(channel);
      if (s) s.delete(listener);
    },
    postMessage: function () {},
  };

  // ---- auth：登录态走 gateway ----
  var authState = { tokens: null, user: null, loaded: false };
  function fetchAuth() {
    var cfg = window.__HILO_CONFIG__ || {};
    var base = cfg.gatewayUrl || "";
    if (!base) return Promise.resolve(null);
    return fetch(base + "/api/auth/token", { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        authState.loaded = true;
        if (d && (d.token || d.userID)) {
          authState.tokens = d.token ? { accessToken: d.token } : null;
          authState.user = d.userID ? { userID: String(d.userID), user_id: String(d.userID) } : null;
        }
        return d;
      })
      .catch(function () { return null; });
  }
  var authPromise = null;
  function ensureAuth() {
    if (!authPromise) authPromise = fetchAuth();
    return authPromise;
  }

  var hilo = {
    ipcRenderer: ipcRenderer,
    auth: {
      getTokens: function () { return ensureAuth().then(function () { return authState.tokens; }); },
      setTokens: function (t) { authState.tokens = t; return Promise.resolve(undefined); },
      clearTokens: function () { authState.tokens = null; return Promise.resolve(undefined); },
      getUser: function () { return ensureAuth().then(function () { return authState.user; }); },
      setUser: function (u) { authState.user = u; return Promise.resolve(undefined); },
      clearUser: function () { authState.user = null; return Promise.resolve(undefined); },
    },
    projectInvite: { onReceived: function () { return function () {}; } },
    updater: {
      checkForUpdates: function () { return Promise.resolve({ updateAvailable: false }); },
      downloadUpdate: function () { return Promise.reject(new Error("webui: no updater")); },
      installUpdate: function () { return Promise.reject(new Error("webui: no updater")); },
    },
    logger: {
      info: function () { return Promise.resolve(undefined); },
      warn: function () { return Promise.resolve(undefined); },
      error: function () { return Promise.resolve(undefined); },
    },
    diagnostics: {
      getRuntimeInfo: function () { return Promise.resolve({ platform: "web", webui: true }); },
      getDiagnosticsContext: function () { return Promise.resolve({}); },
      getLogPath: function () { return Promise.resolve(null); },
      openLogDir: function () { return Promise.resolve(undefined); },
      exportLogs: function () { return Promise.resolve(null); },
      uploadLogs: function () { return Promise.resolve(undefined); },
      getMemoryStats: function () { return Promise.resolve({}); },
      getProxyStatus: function () { return Promise.resolve({ detected: false }); },
      onProxyDetected: function () { return function () {}; },
      onLowMemory: function () { return function () {}; },
    },
    screenshot: { start: function () { return Promise.reject(new Error("webui: no screenshot capability")); } },
    browser: {
      getState: function () { return Promise.resolve({}); },
      getDownloads: function () { return Promise.resolve([]); },
      downloadAction: function () { return Promise.resolve(undefined); },
      onDownloadTransfer: function () { return function () {}; },
      setDownloadSavePrompt: function () { return Promise.resolve(undefined); },
      openDownloadsFolder: function () { return Promise.resolve(undefined); },
      onDownloadsChanged: function () { return function () {}; },
    },
    __webui: true,
  };

  try { Object.defineProperty(window, "hilo", { value: hilo, configurable: false, writable: false }); }
  catch (e) { window.hilo = hilo; }

  window.addEventListener("error", function (ev) {
    try { console.warn("[mweb-shim] window error:", ev.message, ev.filename, ev.lineno); } catch (e) {}
  });

  window.__HILO_SHIM_APPLIED__ = true;
})();
