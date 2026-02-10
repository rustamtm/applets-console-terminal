"use strict";

(() => {
  const basePath = typeof window !== "undefined" && window.__CONSOLE_BASE_PATH__
    ? window.__CONSOLE_BASE_PATH__
    : "";
  const apiBase = `${basePath}/api`;

  const statusEl = document.getElementById("status");
  const sessionInfoEl = document.getElementById("sessionInfo");
  const modeSelect = document.getElementById("modeSelect");
  const cwdInput = document.getElementById("cwdInput");
  const resumeKeyInput = document.getElementById("resumeKey");
  const reconnectBtn = document.getElementById("reconnectBtn");
  const newSessionBtn = document.getElementById("newSessionBtn");
  const newTabBtn = document.getElementById("newTabBtn");
  const tabsEl = document.getElementById("tabs");
  const terminalHost = document.getElementById("terminal");
  const terminalWrap = document.getElementById("terminalWrap");
  if (!terminalHost) return;

  const STORAGE = {
    tabs: "root-console.tabs.v1",
    activeTab: "root-console.activeTab.v1",
    legacyResumeKey: "root-console.resumeKey",
    legacyMode: "root-console.mode",
    legacyCwd: "root-console.cwd"
  };

  let tabs = [];
  let activeTabId = null;
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnectSinceMs = 0;
  let lastConnectError = "";
  let connecting = false;
  let manualClose = false;

  const RECONNECT_CFG = {
    baseMs: 2000,
    maxMs: 30000,
    resumeGraceMs: 3000,
    jitterRatio: 0.2,
    maxSilentAttempts: 3
  };

  function setStatus(text, state) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.state = state || "idle";
  }

  function setSessionInfo(text) {
    if (!sessionInfoEl) return;
    sessionInfoEl.textContent = text;
  }

  function uid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `id_${Math.random().toString(36).slice(2)}`;
  }

  function makeResumeKey() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `resume_${Math.random().toString(36).slice(2)}`;
  }

  function shortToken(value, size) {
    const len = size || 6;
    if (!value) return "";
    if (value.length <= len) return value;
    return value.slice(-len);
  }

  function sanitizeTab(raw, index) {
    const tab = typeof raw === "object" && raw ? { ...raw } : {};
    tab.id = tab.id || uid();
    tab.mode = tab.mode || "tmux";
    tab.cwd = typeof tab.cwd === "string" ? tab.cwd : "";
    tab.resumeKey = tab.resumeKey || makeResumeKey();
    tab.createdAt = typeof tab.createdAt === "number" ? tab.createdAt : Date.now();
    if (typeof tab.tmuxName !== "string" || !tab.tmuxName) {
      tab.tmuxName = null;
    }
    if (typeof tab.label !== "string" || !tab.label) {
      tab.label = null;
    }
    tab.order = typeof tab.order === "number" ? tab.order : index;
    tab.sessionId = typeof tab.sessionId === "string" ? tab.sessionId : null;
    return tab;
  }

  function loadTabs() {
    let parsed = [];
    try {
      const raw = localStorage.getItem(STORAGE.tabs);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data)) parsed = data;
      }
    } catch {
      parsed = [];
    }

    if (!parsed.length) {
      const legacyResumeKey = localStorage.getItem(STORAGE.legacyResumeKey);
      const legacyMode = localStorage.getItem(STORAGE.legacyMode);
      const legacyCwd = localStorage.getItem(STORAGE.legacyCwd);
      if (legacyResumeKey || legacyMode || legacyCwd) {
        parsed = [
          {
            id: uid(),
            mode: legacyMode || "tmux",
            cwd: legacyCwd || "",
            resumeKey: legacyResumeKey || makeResumeKey(),
            createdAt: Date.now()
          }
        ];
      }
    }

    if (!parsed.length) {
      parsed = [
        {
          id: uid(),
          mode: "tmux",
          cwd: "",
          resumeKey: makeResumeKey(),
          createdAt: Date.now()
        }
      ];
    }

    return parsed.map(sanitizeTab).sort((a, b) => a.order - b.order);
  }

  function saveTabs() {
    try {
      localStorage.setItem(STORAGE.tabs, JSON.stringify(tabs));
    } catch {
      // ignore
    }
  }

  function loadActiveTabId() {
    try {
      return localStorage.getItem(STORAGE.activeTab);
    } catch {
      return null;
    }
  }

  function saveActiveTabId(id) {
    try {
      localStorage.setItem(STORAGE.activeTab, id);
    } catch {
      // ignore
    }
  }

  function getActiveTab() {
    return tabs.find((tab) => tab.id === activeTabId) || null;
  }

  function tabLabel(tab, index) {
    if (tab.label) return tab.label;
    if (tab.mode === "tmux") {
      if (tab.tmuxName) return `tmux ${shortToken(tab.tmuxName, 8)}`;
      return `tmux ${index + 1}`;
    }
    if (tab.mode === "shell") return `shell ${index + 1}`;
    if (tab.mode === "node") return `node ${index + 1}`;
    return `session ${index + 1}`;
  }

  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.innerHTML = "";
    tabs.forEach((tab, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tab" + (tab.id === activeTabId ? " active" : "");
      button.dataset.tabId = tab.id;

      const label = document.createElement("span");
      label.textContent = tabLabel(tab, index);
      button.appendChild(label);

      const close = document.createElement("span");
      close.className = "tabClose";
      close.dataset.close = "1";
      close.textContent = "x";
      button.appendChild(close);

      tabsEl.appendChild(button);
    });
  }

  function updateControlsForTab(tab) {
    if (!tab) return;
    if (modeSelect) modeSelect.value = tab.mode || "tmux";
    if (cwdInput) cwdInput.value = tab.cwd || "";
    if (resumeKeyInput) resumeKeyInput.value = tab.resumeKey || "";
  }

  function updateSessionInfo() {
    const tab = getActiveTab();
    if (!tab) {
      setSessionInfo("Session: -");
      return;
    }
    const index = tabs.findIndex((t) => t.id === tab.id);
    const label = tabLabel(tab, index === -1 ? 0 : index);
    const session = tab.sessionId ? shortToken(tab.sessionId, 10) : "-";
    setSessionInfo(`Tab: ${label} | Session: ${session}`);
  }

  function binaryStringToBytes(data) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      out[i] = data.charCodeAt(i) & 0xff;
    }
    return out;
  }

  function bytesToBinaryString(bytes) {
    let out = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.subarray(i, i + chunk);
      out += String.fromCharCode(...slice);
    }
    return out;
  }

  function makeWsUrl(path) {
    if (/^wss?:\/\//i.test(path)) return path;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.host;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${proto}://${host}${normalized}`;
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    if (!res.ok) {
      const message = data && data.error ? data.error : res.statusText;
      const err = new Error(message || "request_failed");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function getJson(url) {
    const res = await fetch(url, { method: "GET" });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    if (!res.ok) {
      const message = data && data.error ? data.error : res.statusText;
      const err = new Error(message || "request_failed");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function closeSession(sessionId) {
    if (!sessionId) return;
    try {
      await postJson(`${apiBase}/sessions/${sessionId}/close`, {});
    } catch {
      // ignore
    }
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    try {
      window.clearTimeout(reconnectTimer);
    } catch {
      // ignore
    }
    reconnectTimer = null;
  }

  function getBackoffDelayMs(attempt) {
    const exp = Math.min(6, Math.max(0, attempt));
    const base = RECONNECT_CFG.baseMs * Math.pow(2, exp);
    const capped = Math.min(RECONNECT_CFG.maxMs, base);
    const jitter = capped * RECONNECT_CFG.jitterRatio * Math.random();
    return Math.round(capped + jitter);
  }

  function scheduleReconnect(options) {
    if (reconnectTimer) return;
    if (connecting) return;
    if (socket && socket.readyState === WebSocket.OPEN) return;
    if (typeof document !== "undefined" && document.hidden) return;

    if (!reconnectSinceMs) reconnectSinceMs = Date.now();
    const minDelayMs = options && typeof options.minDelayMs === "number" ? options.minDelayMs : 0;
    const delayMs = Math.max(minDelayMs, getBackoffDelayMs(reconnectAttempt));
    const attempt = reconnectAttempt + 1;
    reconnectAttempt = attempt;

    // Keep the UI calm for the first few attempts (common on iOS resume).
    if (attempt <= RECONNECT_CFG.maxSilentAttempts) {
      setStatus("Reconnecting", "connecting");
    } else {
      if (lastConnectError) {
        setStatus(`Error: ${lastConnectError}`, "error");
      } else {
        setStatus("Disconnected", "error");
      }
    }

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (manualClose) return;
      if (typeof document !== "undefined" && document.hidden) return;
      connectActiveTab();
    }, delayMs);
  }

  function closeSocket() {
    if (!socket) return;
    manualClose = true;
    try {
      socket.close();
    } catch {
      // ignore
    }
    socket = null;
  }

  function bindSocket(ws, tabId) {
    socket = ws;
    socket.binaryType = "arraybuffer";

    ws.onopen = () => {
      if (activeTabId !== tabId) return;
      reconnectAttempt = 0;
      reconnectSinceMs = 0;
      lastConnectError = "";
      clearReconnectTimer();
      setStatus("Connected", "connected");
      updateSessionInfo();
      scheduleFit();
    };

    ws.onmessage = (event) => {
      if (!term) return;
      if (activeTabId !== tabId) return;

      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg && msg.type === "snapshot" && typeof msg.data === "string") {
            const stickToBottom = isAtBottom();
            term.reset();
            term.write(msg.data, () => {
              if (stickToBottom) term.scrollToBottom();
            });
          }
          if (msg && msg.type === "exit") {
            term.writeln("\r\n[process exited]");
          }
        } catch {
          // ignore
        }
        return;
      }

      const bytes = new Uint8Array(event.data);
      const text = bytesToBinaryString(bytes);
      term.write(text);
    };

    ws.onerror = () => {
      if (socket !== ws) return;
      setStatus("Error", "error");
    };

    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (typeof document !== "undefined" && document.hidden) {
        setStatus("Paused", "idle");
        return;
      }
      if (!manualClose) scheduleReconnect();
    };
  }

  async function hydrateTmuxName(tab) {
    if (!tab || tab.mode !== "tmux" || tab.tmuxName || !tab.sessionId) return;
    try {
      const data = await getJson(`${apiBase}/sessions`);
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      const match = sessions.find((s) => s && s.id === tab.sessionId);
      if (match && match.tmuxName) {
        tab.tmuxName = match.tmuxName;
        saveTabs();
        renderTabs();
      }
    } catch {
      // ignore
    }
  }

  async function attachOrCreate(tab) {
    const cols = term ? term.cols : 120;
    const rows = term ? term.rows : 30;
    const payload = {
      mode: tab.mode,
      resumeKey: tab.resumeKey,
      cols,
      rows
    };
    if (tab.cwd) payload.cwd = tab.cwd;
    if (tab.mode === "tmux" && tab.tmuxName) payload.tmuxName = tab.tmuxName;
    return postJson(`${apiBase}/sessions/attach-or-create`, payload);
  }

  async function connectActiveTab(options) {
    const tab = getActiveTab();
    if (!tab || connecting) return;

    connecting = true;
    clearReconnectTimer();

    setStatus("Connecting", "connecting");
    const currentTabId = tab.id;
    let shouldReconnect = false;

    if (options && options.forceNew) {
      if (tab.sessionId) await closeSession(tab.sessionId);
      tab.resumeKey = makeResumeKey();
      tab.tmuxName = null;
      tab.sessionId = null;
      saveTabs();
      updateControlsForTab(tab);
      renderTabs();
    }

    closeSocket();
    manualClose = false;

    try {
      const data = await attachOrCreate(tab);
      tab.sessionId = data.sessionId;
      saveTabs();
      updateSessionInfo();
      renderTabs();

      if (activeTabId !== currentTabId) {
        connecting = false;
        return;
      }

      if (typeof document !== "undefined" && document.hidden) {
        setStatus("Paused", "idle");
        return;
      }

      const wsUrl = makeWsUrl(data.wsUrl || "");
      const ws = new WebSocket(wsUrl, data.attachToken ? [data.attachToken] : undefined);
      bindSocket(ws, currentTabId);
      hydrateTmuxName(tab);
    } catch (err) {
      const message = err && err.message ? err.message : "connect_failed";
      if (tab.mode === "tmux" && /tmux/i.test(message)) {
        tab.mode = "shell";
        saveTabs();
        updateControlsForTab(tab);
        connecting = false;
        return connectActiveTab();
      }
      lastConnectError = message;
      const status = err && typeof err.status === "number" ? err.status : null;
      const isClientError = typeof status === "number" && status >= 400 && status < 500 && status !== 429;
      shouldReconnect = !isClientError;
      if (isClientError) {
        setStatus(`Error: ${message}`, "error");
      }
      // Avoid spamming the buffer during reconnect loops.
      if (term && (isClientError || reconnectAttempt <= 1)) {
        term.writeln(`\r\nError: ${message}`);
      }
    } finally {
      connecting = false;
      if (shouldReconnect) scheduleReconnect();
    }
  }

  function sendResize() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !term) return;
    socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }

  function isAtBottom() {
    if (!term) return true;
    try {
      const buf = term.buffer && term.buffer.active ? term.buffer.active : null;
      if (!buf) return true;
      return typeof buf.baseY === "number" && typeof buf.viewportY === "number" && buf.viewportY >= buf.baseY;
    } catch {
      return true;
    }
  }

  function setActiveTab(tabId) {
    if (!tabId || activeTabId === tabId) return;
    closeSocket();
    activeTabId = tabId;
    saveActiveTabId(tabId);
    const tab = getActiveTab();
    updateControlsForTab(tab);
    renderTabs();
    updateSessionInfo();
    connectActiveTab();
  }

  function createTabFromCurrent() {
    const current = getActiveTab();
    const mode = current ? current.mode : (modeSelect ? modeSelect.value : "tmux");
    const cwd = current ? current.cwd : (cwdInput ? cwdInput.value.trim() : "");
    return sanitizeTab({
      id: uid(),
      mode,
      cwd,
      resumeKey: makeResumeKey(),
      createdAt: Date.now()
    }, tabs.length);
  }

  function addNewTab() {
    const newTab = createTabFromCurrent();
    tabs.push(newTab);
    tabs = tabs.map((tab, index) => ({ ...tab, order: index }));
    saveTabs();
    renderTabs();
    activeTabId = newTab.id;
    saveActiveTabId(newTab.id);
    updateControlsForTab(newTab);
    updateSessionInfo();
    connectActiveTab({ forceNew: true });
  }

  function closeTab(tabId) {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    const tab = tabs[index];
    if (tab && tab.sessionId) {
      closeSession(tab.sessionId);
    }

    if (tabId === activeTabId) {
      closeSocket();
    }

    tabs.splice(index, 1);
    if (!tabs.length) {
      const fallback = sanitizeTab({ id: uid(), mode: "tmux", cwd: "", resumeKey: makeResumeKey() }, 0);
      tabs.push(fallback);
    }

    tabs = tabs.map((t, idx) => ({ ...t, order: idx }));
    saveTabs();
    renderTabs();

    if (tabId === activeTabId) {
      activeTabId = tabs[0].id;
      saveActiveTabId(activeTabId);
      updateControlsForTab(getActiveTab());
      updateSessionInfo();
      connectActiveTab();
    }
  }

  const term = new window.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "SF Mono, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace",
    theme: {
      background: "#090b10",
      foreground: "#e7e9ee",
      cursor: "#6ee7a3",
      selectionBackground: "rgba(110, 231, 163, 0.2)"
    },
    scrollback: 2000
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(terminalHost);

  let fitRaf = 0;
  function scheduleFit() {
    if (fitRaf) return;
    fitRaf = window.requestAnimationFrame(() => {
      fitRaf = 0;
      const beforeCols = term.cols;
      const beforeRows = term.rows;
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
      if (term.cols === beforeCols && term.rows === beforeRows) {
        sendResize();
      }
    });
  }

  function getCellHeightPx() {
    try {
      const value = term && term._core && term._core._renderService
        && term._core._renderService.dimensions
        && term._core._renderService.dimensions.css
        && term._core._renderService.dimensions.css.cell
        && term._core._renderService.dimensions.css.cell.height;
      if (typeof value === "number" && value > 0) return value;
    } catch {
      // ignore
    }
    return 16;
  }

  function installTouchScroll(target) {
    if (!target) return;

    // Find the xterm viewport element for native-like scrolling
    const getViewport = () => target.querySelector(".xterm-viewport");

    let active = false;
    let lastY = null;
    let velocity = 0;
    let lastTime = 0;
    let momentumRaf = 0;

    const end = () => {
      active = false;

      // Apply momentum scrolling for natural page-like feel
      if (Math.abs(velocity) > 0.5) {
        const viewport = getViewport();
        if (viewport) {
          const applyMomentum = () => {
            if (Math.abs(velocity) < 0.5) {
              momentumRaf = 0;
              return;
            }
            viewport.scrollTop -= velocity;
            velocity *= 0.95; // Friction
            momentumRaf = requestAnimationFrame(applyMomentum);
          };
          if (momentumRaf) cancelAnimationFrame(momentumRaf);
          momentumRaf = requestAnimationFrame(applyMomentum);
        }
      }

      lastY = null;
      velocity = 0;
    };

    target.addEventListener("touchstart", (event) => {
      if (!event.touches || event.touches.length !== 1) return;

      // Cancel any ongoing momentum
      if (momentumRaf) {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = 0;
      }

      active = true;
      lastY = event.touches[0].clientY;
      lastTime = performance.now();
      velocity = 0;
    }, { passive: true, capture: false });

    target.addEventListener("touchmove", (event) => {
      if (!active) return;
      if (!event.touches || event.touches.length !== 1) return;

      // Ensure the terminal owns vertical scrolling on mobile (prevents page/gesture scrolling).
      if (event.cancelable) event.preventDefault();

      const y = event.touches[0].clientY;
      const dy = y - (lastY == null ? y : lastY);
      const now = performance.now();
      const dt = now - lastTime;

      // Calculate velocity for momentum scrolling
      if (dt > 0) {
        velocity = dy / (dt / 16.67); // Normalize to ~60fps
      }

      lastY = y;
      lastTime = now;

      // Scroll the xterm viewport directly for smooth page-like scrolling
      const viewport = getViewport();
      if (viewport) {
        viewport.scrollTop -= dy;
      }
    }, { passive: false, capture: false });

    target.addEventListener("touchend", end, { passive: true, capture: false });
    target.addEventListener("touchcancel", end, { passive: true, capture: false });
  }

  scheduleFit();
  installTouchScroll(terminalWrap || terminalHost);

  term.onData((data) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(binaryStringToBytes(data));
  });

  term.onResize(() => {
    sendResize();
  });

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      scheduleFit();
    });
    observer.observe(terminalHost);
  } else {
    window.addEventListener("resize", () => {
      scheduleFit();
    });
  }

  window.addEventListener("orientationchange", () => {
    window.setTimeout(() => scheduleFit(), 50);
  });

  if (window.visualViewport && typeof window.visualViewport.addEventListener === "function") {
    window.visualViewport.addEventListener("resize", () => scheduleFit());
  }

  try {
    const fontReady = document && document.fonts && document.fonts.ready;
    if (fontReady && typeof fontReady.then === "function") {
      fontReady.then(() => scheduleFit()).catch(() => {
        // ignore
      });
    }
  } catch {
    // ignore
  }

  function repairTerminalAfterResume() {
    scheduleFit();
    try {
      if (typeof term.refresh !== "function") return;
      if (!term.rows || term.rows < 1) return;
      term.refresh(0, term.rows - 1);
    } catch {
      // ignore
    }
  }

  function handlePageHidden() {
    clearReconnectTimer();
    if (socket) closeSocket();
    setStatus("Paused", "idle");
  }

  function handlePageVisible(options) {
    manualClose = false;
    window.setTimeout(() => repairTerminalAfterResume(), 50);
    if (socket && socket.readyState === WebSocket.OPEN) {
      setStatus("Connected", "connected");
      return;
    }
    reconnectAttempt = 0;
    reconnectSinceMs = 0;
    lastConnectError = "";
    scheduleReconnect({ minDelayMs: RECONNECT_CFG.resumeGraceMs, ...options });
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) handlePageHidden();
      else handlePageVisible();
    });
  }

  window.addEventListener("pageshow", (event) => {
    if (event && event.persisted) handlePageVisible({ minDelayMs: RECONNECT_CFG.resumeGraceMs });
  });

  window.addEventListener("pagehide", () => {
    handlePageHidden();
  });

  if (modeSelect) {
    modeSelect.addEventListener("change", () => {
      const tab = getActiveTab();
      if (!tab) return;
      tab.mode = modeSelect.value;
      saveTabs();
      renderTabs();
    });
  }

  if (cwdInput) {
    cwdInput.addEventListener("change", () => {
      const tab = getActiveTab();
      if (!tab) return;
      tab.cwd = cwdInput.value.trim();
      saveTabs();
    });
  }

  if (reconnectBtn) {
    reconnectBtn.addEventListener("click", () => {
      connectActiveTab();
    });
  }

  if (newSessionBtn) {
    newSessionBtn.addEventListener("click", () => {
      connectActiveTab({ forceNew: true });
    });
  }

  if (newTabBtn) {
    newTabBtn.addEventListener("click", () => {
      addNewTab();
    });
  }

  if (tabsEl) {
    tabsEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const close = target.closest(".tabClose");
      const tabButton = target.closest(".tab");
      if (!tabButton) return;
      const tabId = tabButton.dataset.tabId;
      if (!tabId) return;
      if (close) {
        closeTab(tabId);
        return;
      }
      setActiveTab(tabId);
    });
  }

  tabs = loadTabs();
  activeTabId = loadActiveTabId() || (tabs[0] ? tabs[0].id : null);
  if (!activeTabId && tabs[0]) activeTabId = tabs[0].id;
  if (activeTabId) saveActiveTabId(activeTabId);

  renderTabs();
  updateControlsForTab(getActiveTab());
  updateSessionInfo();
  connectActiveTab();
})();
