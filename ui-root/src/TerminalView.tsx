import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export type TerminalConnectionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "disconnected" }
  | { status: "connected"; wsUrl: string; attachToken: string; sessionId: string };

export type TerminalViewHandle = {
  sendText: (text: string) => void;
  focus: () => void;
  getSize: () => { cols: number; rows: number } | null;
  getSnapshot: () => string | null;
  fit: () => void;
  getFontSize: () => number | null;
  setFontSize: (size: number) => number | null;
  stepFontSize: (delta: number) => number | null;
};

export type DisconnectInfo = {
  opened: boolean;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  elapsedMs?: number;
};

type Props = {
  conn: TerminalConnectionState;
  onDisconnect: (info?: DisconnectInfo) => void;
  onSocketEvent?: (event: string, data?: Record<string, unknown>) => void;
  onTitleChange?: (title: string) => void;
  onCwdChange?: (cwd: string) => void;
  onCodexSignal?: (state: "running" | "idle" | "done") => void;
  onOutput?: (text: string) => void;
  onSwipe?: (direction: "left" | "right") => void;
  eventOverridesEnabled?: boolean;
};

function binaryStringToBytes(data: string): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff;
  return out;
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    out += String.fromCharCode(...slice);
  }
  return out;
}

const normalizeBasePath = (raw?: string): string => {
  if (!raw) return "";
  let base = raw.trim();
  if (!base || base === "/") return "";
  if (!base.startsWith("/")) base = `/${base}`;
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
};

const getConsoleBasePath = (): string => {
  if (typeof window === "undefined") return "";
  const configured = (window as any).__CONSOLE_BASE_PATH__;
  if (typeof configured === "string") return normalizeBasePath(configured);
  const pathname = window.location?.pathname || "/";
  if (pathname === "/console" || pathname.startsWith("/console/")) return "/console";
  return "";
};

const cssUrl = (url: string): string => `url("${url}")`;

const maskStyleForSvgButton = (name: string): CSSProperties => {
  const base = getConsoleBasePath();
  const resolved = `${base}/svg-buttons-assets/${encodeURIComponent(name)}`;
  const image = cssUrl(resolved);
  return {
    WebkitMaskImage: image,
    maskImage: image
  } as CSSProperties;
};

const getWantsMobileWritingAssist = (): boolean => {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.matchMedia?.("(pointer: coarse)")?.matches || window.matchMedia?.("(max-width: 720px)")?.matches
  );
};

const getIsAppleTouchDevice = (): boolean => {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1)
  );
};

const ESC = "\u001b";
const BACKSPACE = "\u007f";
const FONT_SIZE_MIN = 9;
const FONT_SIZE_MAX = 22;
// visualViewport deltas also change when browser UI (address bar) expands/collapses.
// Treat only larger deltas as the software keyboard to avoid fighting scrollback.
const KEYBOARD_OFFSET_MIN_PX = 80;

const clampFontSize = (size: number): number =>
  Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));

const repeatSequence = (count: number, sequence: string): string => {
  if (count <= 0 || !sequence) return "";
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += sequence;
  }
  return out;
};

type AppleDictationRevisionState = {
  lastAt: number;
  lastText: string;
};

const APPLE_DICTATION_REVISION_WINDOW_MS = 1500;

const isPlainTextInputBurst = (data: string): boolean => {
  // Exclude control bytes (ESC/CSI, Enter, Backspace, etc.). Dictation revisions arrive as plain text.
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (code === 0x1b || code === 0x7f || code < 0x20) return false;
  }
  return true;
};

const commonPrefixLength = (a: string, b: string): number => {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  for (; i < limit; i += 1) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) break;
  }
  return i;
};

const commonSuffixLength = (a: string, b: string): number => {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  for (; i < limit; i += 1) {
    if (a.charCodeAt(a.length - 1 - i) !== b.charCodeAt(b.length - 1 - i)) break;
  }
  return i;
};

const maybeDedupeAppleDictationRevision = (state: AppleDictationRevisionState, data: string): string => {
  // iOS dictation can emit full "revision" strings (entire phrase) multiple times. When xterm forwards them
  // as-is, the backend receives duplicated text. Approximate IME revision behavior by sending only the delta
  // (and backspaces when needed).
  if (!getIsAppleTouchDevice() || !getWantsMobileWritingAssist()) {
    state.lastAt = 0;
    state.lastText = "";
    return data;
  }

  if (!data || !isPlainTextInputBurst(data)) {
    state.lastAt = 0;
    state.lastText = "";
    return data;
  }

  const now = Date.now();
  const prevAt = state.lastAt;
  const prevText = state.lastText;

  state.lastAt = now;
  state.lastText = data;

  if (!prevAt || now - prevAt > APPLE_DICTATION_REVISION_WINDOW_MS || !prevText) return data;
  if (data === prevText) {
    // Never drop single-character repeats (e.g. "scroll", "__"), but do drop long dictation-style repeats.
    return data.length >= 8 ? "" : data;
  }

  if (data.startsWith(prevText)) return data.slice(prevText.length);
  if (prevText.startsWith(data)) return repeatSequence(prevText.length - data.length, BACKSPACE);

  const prefix = commonPrefixLength(prevText, data);
  if (prefix <= 0) return data;

  const minLen = Math.min(prevText.length, data.length);
  const ratio = minLen > 0 ? prefix / minLen : 0;
  const strongPrefix = prefix >= 6 || (prefix >= 4 && ratio >= 0.8);
  if (!strongPrefix) {
    // Dictation revisions frequently insert punctuation near the start ("OK," vs "OK") which defeats the
    // common-prefix delta approach. If the two bursts still overlap heavily, delete the previous burst and
    // retype the new one (approximate IME replacement behavior).
    const suffix = commonSuffixLength(prevText, data);
    const overlap = Math.min(minLen, prefix + suffix);
    const overlapRatio = minLen > 0 ? overlap / minLen : 0;
    const isLikelyReplacement = minLen >= 12 && overlap >= 10 && overlapRatio >= 0.7;
    if (isLikelyReplacement) {
      return repeatSequence(prevText.length, BACKSPACE) + data;
    }
    return data;
  }

  const deleteCount = prevText.length - prefix;
  const add = data.slice(prefix);
  return repeatSequence(deleteCount, BACKSPACE) + add;
};

const sequenceForDirection = (direction: "A" | "B" | "C" | "D", applicationCursor: boolean): string =>
  `${ESC}${applicationCursor ? "O" : "["}${direction}`;

const getWrappedRange = (buffer: { getLine: (index: number) => any; length: number }, row: number) => {
  let start = row;
  let line = buffer.getLine(start);
  while (start > 0 && line?.isWrapped) {
    start -= 1;
    line = buffer.getLine(start);
  }
  let end = row;
  let next = buffer.getLine(end + 1);
  while (end + 1 < buffer.length && next?.isWrapped) {
    end += 1;
    next = buffer.getLine(end + 1);
  }
  return { start, end };
};

export const TerminalView = forwardRef<TerminalViewHandle, Props>(
  ({ conn, onDisconnect, onSocketEvent, onTitleChange, onCwdChange, onCodexSignal, onOutput, onSwipe, eventOverridesEnabled }, ref) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const wsAttemptRef = useRef(0);
  const onDisconnectRef = useRef<Props["onDisconnect"]>(onDisconnect);
  const onSocketEventRef = useRef<Props["onSocketEvent"]>(onSocketEvent);
  const onTitleChangeRef = useRef<Props["onTitleChange"]>(undefined);
  const onCwdChangeRef = useRef<Props["onCwdChange"]>(undefined);
  const onCodexSignalRef = useRef<Props["onCodexSignal"]>(undefined);
  const onOutputRef = useRef<Props["onOutput"]>(undefined);
  const appleDictationRevisionRef = useRef<AppleDictationRevisionState>({ lastAt: 0, lastText: "" });
  const initialIsSmall = useMemo(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 720px)").matches;
  }, []);
  const [isSmallScreen, setIsSmallScreen] = useState(initialIsSmall);
  const isSmallScreenRef = useRef(initialIsSmall);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollCheckRef = useRef<number | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const scrubberRailRef = useRef<HTMLDivElement | null>(null);
  const scrubberPointerRef = useRef<{ active: boolean; pointerId: number | null }>({ active: false, pointerId: null });
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubberMetrics, setScrubberMetrics] = useState<{ visible: boolean; thumbTop: number; thumbHeight: number }>(
    () => ({
      visible: false,
      thumbTop: 0,
      thumbHeight: 0
    })
  );
  const keyboardOffsetRef = useRef(0);
  const fontSizeOverrideRef = useRef<number | null>(null);
  const fontSizeRef = useRef<number>(initialIsSmall ? 11 : 13);
  const wheelRemainderRef = useRef(0);
  const pinchRef = useRef<{
    active: boolean;
    startDistance: number;
    startSize: number;
    lastSize: number;
  }>({ active: false, startDistance: 0, startSize: 13, lastSize: 13 });
  const swipeRef = useRef<{
    active: boolean;
    triggered: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  }>({ active: false, triggered: false, startX: 0, startY: 0, lastX: 0, lastY: 0 });
  const touchScrollRef = useRef<{
    active: boolean;
    moved: boolean;
    activated: boolean;
    startTime: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    startViewportY: number;
  }>({
    active: false,
    moved: false,
    activated: false,
    startTime: 0,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startViewportY: 0
  });

  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);

  useEffect(() => {
    onSocketEventRef.current = onSocketEvent;
  }, [onSocketEvent]);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    onCwdChangeRef.current = onCwdChange;
  }, [onCwdChange]);

  useEffect(() => {
    onCodexSignalRef.current = onCodexSignal;
  }, [onCodexSignal]);

  useEffect(() => {
    onOutputRef.current = onOutput;
  }, [onOutput]);

  const updateAtBottom = useCallback(() => {
    let nextAtBottom: boolean | null = null;
    const term = termRef.current;
    if (term) {
      const buffer = term.buffer.active;
      nextAtBottom = buffer.baseY === buffer.viewportY;
    } else {
      const viewport = viewportRef.current;
      if (viewport) {
        const threshold = 2;
        nextAtBottom = viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - threshold;
      }
    }

    if (nextAtBottom !== null) {
      atBottomRef.current = nextAtBottom;
      setIsAtBottom(nextAtBottom);
    }

    const wantsScrubber = true;
    const viewport = viewportRef.current;
    const rail = scrubberRailRef.current;
    if (!wantsScrubber || !viewport || !rail) {
      setScrubberMetrics((prev) => (prev.visible ? { visible: false, thumbTop: 0, thumbHeight: 0 } : prev));
      return;
    }

    const railHeight = rail.clientHeight;
    const scrollMax = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (!railHeight || scrollMax <= 0) {
      setScrubberMetrics((prev) => (prev.visible ? { visible: false, thumbTop: 0, thumbHeight: 0 } : prev));
      return;
    }

    const ratio = Math.min(1, Math.max(0, viewport.scrollTop / scrollMax));
    const sizeRatio = viewport.scrollHeight > 0 ? viewport.clientHeight / viewport.scrollHeight : 1;
    const minThumb = 34;
    const rawThumbHeight = Math.round(railHeight * sizeRatio);
    const thumbHeight = Math.min(railHeight, Math.max(minThumb, rawThumbHeight));
    const thumbTop = Math.round((railHeight - thumbHeight) * ratio);

    setScrubberMetrics((prev) => {
      if (prev.visible && prev.thumbTop === thumbTop && prev.thumbHeight === thumbHeight) return prev;
      return { visible: true, thumbTop, thumbHeight };
    });
  }, []);

  const scheduleScrollCheck = useCallback(() => {
    if (scrollCheckRef.current !== null) return;
    scrollCheckRef.current = window.requestAnimationFrame(() => {
      scrollCheckRef.current = null;
      updateAtBottom();
    });
  }, [updateAtBottom]);

  const scrollToTop = useCallback(() => {
    const term = termRef.current;
    if (term) {
      term.scrollToTop();
    }
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = 0;
    }
    wheelRemainderRef.current = 0;
    scheduleScrollCheck();
  }, [scheduleScrollCheck]);

  useEffect(() => {
    isSmallScreenRef.current = isSmallScreen;
    scheduleScrollCheck();
  }, [isSmallScreen, scheduleScrollCheck]);

  const scrollScrubberToClientY = useCallback(
    (clientY: number) => {
      const viewport = viewportRef.current;
      const rail = scrubberRailRef.current;
      if (!viewport || !rail) return;
      const rect = rail.getBoundingClientRect();
      if (!rect.height) return;
      const ratio = (clientY - rect.top) / rect.height;
      const clamped = Math.min(1, Math.max(0, ratio));
      const scrollMax = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = clamped * scrollMax;
      scheduleScrollCheck();
    },
    [scheduleScrollCheck]
  );

  const handleScrubberPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const rail = scrubberRailRef.current;
      if (!rail) return;
      event.preventDefault();
      event.stopPropagation();
      scrubberPointerRef.current.active = true;
      scrubberPointerRef.current.pointerId = event.pointerId;
      setIsScrubbing(true);
      try {
        rail.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      scrollScrubberToClientY(event.clientY);
    },
    [scrollScrubberToClientY]
  );

  const handleScrubberPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = scrubberPointerRef.current;
      if (!state.active || state.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      scrollScrubberToClientY(event.clientY);
    },
    [scrollScrubberToClientY]
  );

  const handleScrubberPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = scrubberPointerRef.current;
    if (!state.active || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    state.active = false;
    state.pointerId = null;
    setIsScrubbing(false);
    try {
      scrubberRailRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => setIsSmallScreen(media.matches);
    update();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const viewport = window.visualViewport;
    if (!viewport) return;

    const updateViewport = () => {
      const rawOffset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      const offset = rawOffset >= KEYBOARD_OFFSET_MIN_PX ? rawOffset : 0;
      if (Math.abs(offset - keyboardOffsetRef.current) < 1) {
        scheduleScrollCheck();
        return;
      }
      keyboardOffsetRef.current = offset;
      document.documentElement.style.setProperty("--keyboard-offset", `${Math.round(offset)}px`);
      if (offset > 0 && atBottomRef.current) {
        termRef.current?.scrollToBottom();
      }
      requestAnimationFrame(() => fitRef.current?.fit());
      scheduleScrollCheck();
    };

    updateViewport();
    viewport.addEventListener("resize", updateViewport);
    viewport.addEventListener("scroll", updateViewport);
    return () => {
      viewport.removeEventListener("resize", updateViewport);
      viewport.removeEventListener("scroll", updateViewport);
      document.documentElement.style.setProperty("--keyboard-offset", "0px");
    };
  }, [scheduleScrollCheck]);

  const sendInput = useCallback((data: string) => {
    if (!data) return;
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(binaryStringToBytes(data));
  }, []);

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const moveCursorToPoint = useCallback(
    (clientX: number, clientY: number) => {
      const term = termRef.current;
      if (!term || term.hasSelection()) return;
      if (!term.cols || !term.rows) return;
      const element = term.element;
      if (!element) return;

      const core = (term as any)._core;
      const mouseService = core?._mouseService;
      const coords = mouseService?.getCoords
        ? mouseService.getCoords({ clientX, clientY }, element, term.cols, term.rows, false)
        : (() => {
            const rect = element.getBoundingClientRect();
            const cell = core?._renderService?.dimensions?.css?.cell;
            const cellWidth = cell?.width || rect.width / Math.max(1, term.cols);
            const cellHeight = cell?.height || rect.height / Math.max(1, term.rows);
            if (!cellWidth || !cellHeight) return undefined;
            const x = Math.min(Math.max(clientX - rect.left, 0), rect.width - 1);
            const y = Math.min(Math.max(clientY - rect.top, 0), rect.height - 1);
            const col = Math.floor(x / cellWidth) + 1;
            const row = Math.floor(y / cellHeight) + 1;
            return [col, row];
          })();

      if (!coords || coords[0] === undefined || coords[1] === undefined) return;
      const buffer = term.buffer.active;
      if (buffer.baseY !== buffer.viewportY) return;

      const targetX = Math.min(Math.max(coords[0] - 1, 0), term.cols - 1);
      const targetY = Math.min(Math.max(coords[1] - 1, 0), term.rows - 1);
      const startX = buffer.cursorX;
      const startY = buffer.cursorY;
      if (targetX === startX && targetY === startY) return;

      const cursorAbs = buffer.baseY + startY;
      const targetAbs = buffer.viewportY + targetY;
      const wrapped = getWrappedRange(buffer, cursorAbs);
      if (targetAbs < wrapped.start || targetAbs > wrapped.end) return;

      const applicationCursor = Boolean(core?._coreService?.decPrivateModes?.applicationCursorKeys);
      const moveLeft = sequenceForDirection("D", applicationCursor);
      const moveRight = sequenceForDirection("C", applicationCursor);

      let sequence = "";
      if (startY === targetY) {
        const delta = targetX - startX;
        sequence = delta > 0 ? repeatSequence(delta, moveRight) : repeatSequence(-delta, moveLeft);
      } else {
        const direction = startY > targetY ? moveLeft : moveRight;
        const rowDiff = Math.abs(startY - targetY);
        const cols = term.cols;
        const colsFromRowEnd = (currX: number) => cols - currX;
        const colsFromRowBeginning = (currX: number) => currX - 1;
        const cellsToMove =
          colsFromRowEnd(startY > targetY ? targetX : startX) +
          (rowDiff - 1) * cols +
          1 +
          colsFromRowBeginning(startY > targetY ? startX : targetX);
        sequence = repeatSequence(cellsToMove, direction);
      }

      if (sequence) {
        sendInput(sequence);
        focusTerminal();
      }
    },
    [focusTerminal, sendInput]
  );

  const applyFontSize = useCallback(
    (size: number) => {
      const nextSize = clampFontSize(size);
      fontSizeRef.current = nextSize;
      fontSizeOverrideRef.current = nextSize;
      const term = termRef.current;
      if (!term) return;
      if (term.options.fontSize === nextSize) return;
      term.options.fontSize = nextSize;
      requestAnimationFrame(() => fitRef.current?.fit());
      scheduleScrollCheck();
    },
    [scheduleScrollCheck]
  );

  useEffect(() => {
    if (!containerRef.current) return;
    if (termRef.current) return;

    // iOS Safari makes the default block/outline cursor feel huge; prefer a thin bar cursor on
    // touch devices/small screens so the cursor doesn't read as a big white "box".
    const isAppleTouchDevice = getIsAppleTouchDevice();
    const prefersBarCursor = getWantsMobileWritingAssist() || isAppleTouchDevice;
    const cursorColor = prefersBarCursor ? "rgba(100, 210, 255, 0.7)" : "#e6edf3";

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: prefersBarCursor ? false : true,
      cursorStyle: prefersBarCursor ? "bar" : "block",
      cursorInactiveStyle: prefersBarCursor ? "none" : "outline",
      cursorWidth: prefersBarCursor ? 1 : 1,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: initialIsSmall ? 11 : 13,
      rightClickSelectsWord: true,
      macOptionClickForcesSelection: true,
      scrollback: 10000,
      wordSeparator: " ()[]{}<>`'\"\t",
      theme: {
        background: "#0b0f14",
        cursor: cursorColor,
        cursorAccent: "#0b0f14",
        selectionBackground: "rgba(100, 210, 255, 0.35)",
        selectionInactiveBackground: "rgba(100, 210, 255, 0.2)"
      }
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(serialize);
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(containerRef.current);
    fit.fit();

    const viewport = terminal.element?.querySelector(".xterm-viewport") as HTMLDivElement | null;
    viewportRef.current = viewport;
    const onScroll = terminal.onScroll(() => {
      if (touchScrollRef.current.active) touchScrollRef.current.moved = true;
      scheduleScrollCheck();
    });
    scheduleScrollCheck();

    const titleDisposable = terminal.onTitleChange((title) => {
      try {
        onTitleChangeRef.current?.(title);
      } catch {
        // ignore
      }
    });
    const oscDisposables: Array<{ dispose: () => void }> = [];
    const parser = (terminal as any).parser;
    if (parser?.registerOscHandler) {
      try {
        const cwdDisposable = parser.registerOscHandler(7, (data: string) => {
          try {
            onCwdChangeRef.current?.(data);
          } catch {
            // ignore
          }
          return false;
        });
        if (cwdDisposable?.dispose) oscDisposables.push(cwdDisposable);
      } catch {
        // ignore
      }
      try {
        const codexDisposable = parser.registerOscHandler(777, (data: string) => {
          try {
            const normalized = String(data ?? "").trim().toLowerCase();
            let value = normalized;
            if (value.startsWith("codex=") || value.startsWith("codex:")) {
              value = value.slice(6).trim();
            } else if (value.startsWith("codex ")) {
              value = value.slice(6).trim();
            }
            if (value === "running" || value === "idle" || value === "done") {
              onCodexSignalRef.current?.(value);
            }
          } catch {
            // ignore
          }
          return false;
        });
        if (codexDisposable?.dispose) oscDisposables.push(codexDisposable);
      } catch {
        // ignore
      }
    }

    // Mobile keyboard: try to keep writing suggestions/autocorrect enabled on iOS.
    // xterm disables these by default (for good reasons), but on phone it's often worth it.
    const input = terminal.textarea as HTMLTextAreaElement | undefined;
    // iPadOS with a trackpad often reports a fine pointer, but users still expect iOS keyboard
    // writing suggestions/autocorrect. Treat Apple touch devices as "wants writing assist".
    const wantsWritingAssist = getWantsMobileWritingAssist() || isAppleTouchDevice;

    const applyWritingAssistAttrs = () => {
      if (!input || !wantsWritingAssist) return;
      input.setAttribute("autocomplete", "on");
      input.setAttribute("autocorrect", "on");
      input.setAttribute("autocapitalize", "none");
      input.setAttribute("spellcheck", "true");
      input.setAttribute("writingsuggestions", "true");
      input.setAttribute("inputmode", "text");
      input.setAttribute("enterkeyhint", "enter");
      input.setAttribute("name", "terminal");
      input.setAttribute("id", "terminal");

      // Some iOS/Safari behaviors key off properties rather than attributes.
      input.spellcheck = true;
      (input as any).inputMode = "text";
      (input as any).enterKeyHint = "enter";
    };

    const applyIOSWritingAssistHack = () => {
      if (!input || !wantsWritingAssist || !isAppleTouchDevice) return;

      // iOS Safari can suppress suggestions for a fully-hidden/negative-z-index textarea.
      // Keep it effectively invisible but still "real" to the keyboard.
      input.style.opacity = "1";
      input.style.zIndex = "0";
      input.style.pointerEvents = "none";
      input.style.color = "transparent";
      input.style.backgroundColor = "transparent";
      input.style.caretColor = "transparent";
    };

    applyWritingAssistAttrs();
    applyIOSWritingAssistHack();
    const inputFixDisposable = terminal.onRender(() => applyIOSWritingAssistHack());

    // iPadOS/iOS can surface a disruptive "Undo Typing" popover via editing gestures while the terminal
    // textarea is focused. Block history undo/redo inputs so xterm can continue handling control keys.
    const undoBlockCleanup = (() => {
      if (!input) return () => {};
      const handler = (event: InputEvent) => {
        const inputType = (event as any)?.inputType;
        if (inputType !== "historyUndo" && inputType !== "historyRedo") return;
        if (event.cancelable) event.preventDefault();
      };
      input.addEventListener("beforeinput", handler as any, { capture: true });
      return () => {
        input.removeEventListener("beforeinput", handler as any, { capture: true });
      };
    })();

    const onResize = terminal.onResize(({ cols, rows }) => {
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    const applyFit = () => {
      const isSmall = window.matchMedia("(max-width: 720px)").matches;
      const baseSize = isSmall ? 11 : 13;
      const nextSize = fontSizeOverrideRef.current ?? baseSize;
      if (terminal.options.fontSize !== nextSize) {
        terminal.options.fontSize = nextSize;
        fontSizeRef.current = nextSize;
      }
      requestAnimationFrame(() => {
        fit.fit();
        scheduleScrollCheck();
      });
    };

    const onWindowResize = () => applyFit();
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("orientationchange", onWindowResize);
    window.visualViewport?.addEventListener("resize", onWindowResize);
    applyFit();

    // Keep terminal geometry in sync with container changes (iPad Safari can be finicky about this).
    let resizeRaf: number | null = null;
    const requestFit = () => {
      if (resizeRaf !== null) return;
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = null;
        applyFit();
      });
    };

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => requestFit());
      try {
        resizeObserver.observe(containerRef.current);
      } catch {
        // ignore
      }
    }

    // If fonts load after our initial fit, the character measurement can change. Refit once.
    try {
      const fontReady = (document as any)?.fonts?.ready;
      if (fontReady && typeof fontReady.then === "function") {
        fontReady.then(requestFit).catch(() => {
          // ignore
        });
      }
    } catch {
      // ignore
    }

    termRef.current = terminal;
    fitRef.current = fit;
    serializeRef.current = serialize;

    return () => {
      titleDisposable.dispose();
      for (const disposable of oscDisposables) {
        try {
          disposable.dispose();
        } catch {
          // ignore
        }
      }
      inputFixDisposable.dispose();
      undoBlockCleanup();
      onScroll.dispose();
      onResize.dispose();
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("orientationchange", onWindowResize);
      window.visualViewport?.removeEventListener("resize", onWindowResize);
      if (resizeObserver) {
        try {
          resizeObserver.disconnect();
        } catch {
          // ignore
        }
      }
      if (resizeRaf !== null) {
        window.cancelAnimationFrame(resizeRaf);
        resizeRaf = null;
      }
      viewportRef.current = null;
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
      serializeRef.current = null;
    };
  }, [scheduleScrollCheck, initialIsSmall]);

  const overridesEnabled = eventOverridesEnabled ?? true;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const mouseState = { active: false, moved: false, startX: 0, startY: 0, startTime: 0 };

	    const isInteractiveTarget = (target: EventTarget | null) => {
	      if (!(target instanceof HTMLElement)) return false;
	      return Boolean(
	        target.closest(".terminalMobileBar") ||
	          target.closest(".terminalScrollScrubber") ||
	          target.closest(".terminalCompose") ||
	          target.closest(".terminalScrollLock") ||
	          target.closest("button") ||
	          target.closest("select") ||
          target.closest("input") ||
          target.closest("textarea") ||
          target.closest("a")
      );
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (isInteractiveTarget(event.target)) return;
      if (event.touches.length === 2) {
        // Handle pinch-to-zoom as "change terminal font size" instead of browser zoom.
        if (event.cancelable) event.preventDefault();
        const [a, b] = event.touches;
        const dx = a.clientX - b.clientX;
        const dy = a.clientY - b.clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const startSize = fontSizeRef.current || 13;
        pinchRef.current = {
          active: true,
          startDistance: dist,
          startSize,
          lastSize: startSize
        };
        touchScrollRef.current.active = false;
        swipeRef.current.active = false;
        return;
      }
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const state = touchScrollRef.current;
      state.active = true;
      state.moved = false;
      state.activated = false;
      state.startTime = Date.now();
      state.startX = touch.clientX;
      state.startY = touch.clientY;
      state.lastX = touch.clientX;
      state.lastY = touch.clientY;
      state.startViewportY = termRef.current?.buffer.active.viewportY ?? 0;

      swipeRef.current = {
        active: true,
        triggered: false,
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const term = termRef.current;
      if (!term) return;
      if (pinchRef.current.active && event.touches.length === 2) {
        const [a, b] = event.touches;
        const dx = a.clientX - b.clientX;
        const dy = a.clientY - b.clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const scale = dist / Math.max(1, pinchRef.current.startDistance);
        const nextSize = pinchRef.current.startSize * scale;
        if (Math.abs(nextSize - pinchRef.current.lastSize) >= 0.5) {
          pinchRef.current.lastSize = nextSize;
          applyFontSize(nextSize);
        }
        if (event.cancelable) event.preventDefault();
        return;
      }
      if (pinchRef.current.active) return;

      const swipe = swipeRef.current;
      if (swipe.active && event.touches.length === 1) {
        const touch = event.touches[0];
        swipe.lastX = touch.clientX;
        swipe.lastY = touch.clientY;
        const dx = swipe.lastX - swipe.startX;
        const dy = swipe.lastY - swipe.startY;
        if (!swipe.triggered) {
          if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy) * 1.4) {
            swipe.triggered = true;
            touchScrollRef.current.active = false;
            touchScrollRef.current.moved = true;
          } else if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
            swipe.active = false;
          }
        }
        if (swipe.triggered) {
          if (event.cancelable) event.preventDefault();
          return;
        }
      }

      const state = touchScrollRef.current;
      if (!state.active) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dxTotal = touch.clientX - state.startX;
      const dyTotal = touch.clientY - state.startY;
      if (Math.abs(dyTotal) > 3 || Math.abs(dxTotal) > 3) state.moved = true;

      state.lastX = touch.clientX;
      state.lastY = touch.clientY;
      // Prefer native browser scrolling of the xterm viewport on touch devices.
      // Synthesizing wheel events here makes mouse-aware TUIs (tmux/vim) treat vertical swipes
      // as application scroll, which is surprising on mobile.
      return;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (pinchRef.current.active && event.touches.length < 2) {
        pinchRef.current.active = false;
      }

      const swipe = swipeRef.current;
      if (swipe.active && swipe.triggered) {
        const dx = swipe.lastX - swipe.startX;
        swipe.active = false;
        swipe.triggered = false;
        if (Math.abs(dx) >= 60) {
          onSwipe?.(dx > 0 ? "right" : "left");
        }
        return;
      }
      swipe.active = false;

      const state = touchScrollRef.current;
      if (!state.active) return;
      state.active = false;
      const term = termRef.current;
      const scrolled = term ? term.buffer.active.viewportY !== state.startViewportY : false;
      if (!state.moved && !scrolled && !isInteractiveTarget(event.target)) {
        const touch = event.changedTouches[0];
        if (touch) {
          moveCursorToPoint(touch.clientX, touch.clientY);
        } else {
          focusTerminal();
        }
      }
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (isInteractiveTarget(event.target)) return;
      mouseState.active = true;
      mouseState.moved = false;
      mouseState.startX = event.clientX;
      mouseState.startY = event.clientY;
      mouseState.startTime = event.timeStamp || Date.now();
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (!mouseState.active) return;
      const dx = event.clientX - mouseState.startX;
      const dy = event.clientY - mouseState.startY;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        mouseState.moved = true;
      }
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (!mouseState.active) return;
      mouseState.active = false;
      if (mouseState.moved) return;
      if (event.detail && event.detail > 1) return;
      const elapsed = (event.timeStamp || Date.now()) - mouseState.startTime;
      if (elapsed > 500) return;
      if (isInteractiveTarget(event.target)) return;
      moveCursorToPoint(event.clientX, event.clientY);
    };

    // Some Apple devices (notably iPad Safari with a trackpad) can deliver wheel events to the
    // focused element instead of the hovered element. That makes scrollback appear "broken" until
    // the user clicks into the terminal. If the wheel event target isn't inside the terminal but
    // the pointer is over it, redirect the wheel event into xterm so our normal wheel handler runs.
    const handleWheelGlobalCapture = (event: WheelEvent) => {
      if (typeof document === "undefined") return;
      const host = hostRef.current;
      if (!host) return;
      const rawTarget = event.target;
      if (rawTarget instanceof Node && host.contains(rawTarget)) return;
      if ((event as any).__consoleTouchWheel) return;

      const x = event.clientX;
      const y = event.clientY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const hovered = document.elementFromPoint(x, y);
      if (!(hovered instanceof HTMLElement)) return;
      if (!host.contains(hovered)) return;

      const viewport = viewportRef.current;
      const term = termRef.current;
      const target = viewport ?? (term?.element as HTMLElement | null);
      if (!target) return;

      if (event.cancelable) event.preventDefault();
      event.stopPropagation();

      const wheel = new WheelEvent("wheel", {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey
      });
      target.dispatchEvent(wheel);
    };

    // When a full-screen TUI enables mouse reporting, xterm.js will send wheel
    // events to the application instead of scrolling scrollback (Shift+wheel
    // forces scrollback). For "page-like" scrollback by default, we stop wheel
    // propagation before xterm sees it, letting the browser scroll the xterm
    // viewport naturally. Hold Alt to forward wheel events to the application.
    const handleWheelCapture = (event: WheelEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.closest(".xterm")) return;
      if ((event as any).__consoleTouchWheel) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      const term = termRef.current as any;
      // If there is no scrollback (e.g., alternate screen like tmux/vim), don't swallow the
      // wheel event. Let xterm forward it to the application (mouse mode) instead.
      const baseY = term?.buffer?.active?.baseY;
      if (!Number.isFinite(baseY) || baseY <= 0) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();

      // Implement scrolling ourselves so synthetic wheel events (E2E) still work
      // and to avoid xterm's mouse-mode wheel forwarding.
      if (!term?.scrollLines) return;
      const cellHeight = term?._core?._renderService?.dimensions?.actualCellHeight;
      const pxPerLine = typeof cellHeight === "number" && cellHeight > 0 ? cellHeight : 16;
      const viewport = viewportRef.current;
      const deltaPx =
        event.deltaMode === 1
          ? event.deltaY * pxPerLine
          : event.deltaMode === 2
            ? event.deltaY * (viewport?.clientHeight ?? pxPerLine * (term.rows || 30))
            : event.deltaY;

      wheelRemainderRef.current += deltaPx;
      const lines = Math.trunc(wheelRemainderRef.current / pxPerLine);
      if (!lines) return;
      wheelRemainderRef.current -= lines * pxPerLine;
      term.scrollLines(lines);
    };

    if (overridesEnabled) {
      host.addEventListener("touchstart", handleTouchStart, { passive: false, capture: true });
      host.addEventListener("touchmove", handleTouchMove, { passive: false, capture: true });
      host.addEventListener("touchend", handleTouchEnd, { capture: true });
      host.addEventListener("touchcancel", handleTouchEnd, { capture: true });
      host.addEventListener("mousedown", handleMouseDown);
      host.addEventListener("mousemove", handleMouseMove);
      host.addEventListener("mouseup", handleMouseUp);
      host.addEventListener("wheel", handleWheelCapture, { capture: true, passive: false });
      document.addEventListener("wheel", handleWheelGlobalCapture, { capture: true, passive: false });
    }

    return () => {
      if (overridesEnabled) {
        host.removeEventListener("touchstart", handleTouchStart, { capture: true });
        host.removeEventListener("touchmove", handleTouchMove, { capture: true });
        host.removeEventListener("touchend", handleTouchEnd, { capture: true });
        host.removeEventListener("touchcancel", handleTouchEnd, { capture: true });
        host.removeEventListener("mousedown", handleMouseDown);
        host.removeEventListener("mousemove", handleMouseMove);
        host.removeEventListener("mouseup", handleMouseUp);
        host.removeEventListener("wheel", handleWheelCapture, { capture: true } as any);
        document.removeEventListener("wheel", handleWheelGlobalCapture, { capture: true } as any);
      }
    };
  }, [applyFontSize, focusTerminal, moveCursorToPoint, onSwipe, scheduleScrollCheck, overridesEnabled]);

  useImperativeHandle(
    ref,
    () => ({
      sendText: (text: string) => sendInput(text),
      focus: () => focusTerminal(),
      fit: () => {
        requestAnimationFrame(() => {
          fitRef.current?.fit();
          scheduleScrollCheck();
        });
      },
      getSize: () => {
        const term = termRef.current;
        if (!term) return null;
        if (!term.cols || !term.rows) return null;
        return { cols: term.cols, rows: term.rows };
      },
      getSnapshot: () => serializeRef.current?.serialize() ?? null,
      getFontSize: () => {
        const size = termRef.current?.options.fontSize;
        if (typeof size === "number" && Number.isFinite(size)) return size;
        return Number.isFinite(fontSizeRef.current) ? fontSizeRef.current : null;
      },
      setFontSize: (size: number) => {
        applyFontSize(size);
        return Number.isFinite(fontSizeRef.current) ? fontSizeRef.current : null;
      },
      stepFontSize: (delta: number) => {
        const current = Number.isFinite(fontSizeRef.current) ? fontSizeRef.current : 13;
        applyFontSize(current + delta);
        return Number.isFinite(fontSizeRef.current) ? fontSizeRef.current : null;
      }
    }),
    [sendInput, focusTerminal, scheduleScrollCheck, applyFontSize]
  );

  const sendSpecial = useCallback(
    (sequence: string) => {
      if (!sequence) return;
      sendInput(sequence);
      focusTerminal();
    },
    [sendInput, focusTerminal]
  );

  const pasteFromClipboard = useCallback(async () => {
    let text = "";
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText();
      } else if (typeof window !== "undefined") {
        text = window.prompt("Paste text to send to the terminal:", "") ?? "";
      }
    } catch {
      if (typeof window !== "undefined") {
        text = window.prompt("Paste text to send to the terminal:", "") ?? "";
      }
    }

    if (text) sendInput(text);
    focusTerminal();
  }, [focusTerminal, sendInput]);

  const jumpToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
    atBottomRef.current = true;
    setIsAtBottom(true);
    scheduleScrollCheck();
    focusTerminal();
  }, [focusTerminal, scheduleScrollCheck]);

  const jumpToTop = useCallback(() => {
    termRef.current?.scrollToTop();
    atBottomRef.current = false;
    setIsAtBottom(false);
    scheduleScrollCheck();
    focusTerminal();
  }, [focusTerminal, scheduleScrollCheck]);

  useEffect(() => {
    const terminal = termRef.current;
    if (!terminal) return;

    // Clean up existing socket.
    const prior = socketRef.current;
    if (prior) {
      try {
        if (prior.readyState === WebSocket.OPEN || prior.readyState === WebSocket.CONNECTING) {
          prior.close(1000, "swap");
        }
      } catch {
        // ignore
      }
      socketRef.current = null;
    }

    if (conn.status !== "connected") return;

    const emitSocketEvent = (event: string, data?: Record<string, unknown>) => {
      try {
        onSocketEventRef.current?.(event, data);
      } catch {
        // ignore
      }
    };

    const redactWsUrl = (raw: string) => {
      try {
        const url = new URL(raw, window.location.href);
        url.searchParams.delete("attachToken");
        url.searchParams.delete("token");
        url.hash = "";
        return url.toString();
      } catch {
        return raw
          .replace(/attachToken=[^&]+/g, "attachToken=REDACTED")
          .replace(/token=[^&]+/g, "token=REDACTED");
      }
    };

    let canceled = false;
    let opened = false;
    let disconnectFired = false;
    let heartbeatTimer: number | null = null;
    let ws: WebSocket | null = null;
    let onDataDisposable: { dispose: () => void } | null = null;

    const connectTimer = window.setTimeout(() => {
      if (canceled) return;

      const attempt = (wsAttemptRef.current += 1);
      const createdAt = Date.now();
      const redactedUrl = redactWsUrl(conn.wsUrl);
      emitSocketEvent("ws.create", {
        sessionId: conn.sessionId,
        attempt,
        url: redactedUrl
      });

      ws = new WebSocket(conn.wsUrl);
      ws.binaryType = "arraybuffer";
      socketRef.current = ws;

      const sendClientFrame = (type: "hello" | "ping") => {
        if (canceled || socketRef.current !== ws) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type, at: Date.now() }));
        } catch {
          // ignore
        }
      };

      ws.onopen = () => {
        if (canceled || socketRef.current !== ws) return;
        opened = true;
        sendClientFrame("hello");
        heartbeatTimer = window.setInterval(() => sendClientFrame("ping"), 30_000);
        focusTerminal();
        fitRef.current?.fit();
        termRef.current?.scrollToBottom();
        atBottomRef.current = true;
        setIsAtBottom(true);
        scheduleScrollCheck();
        emitSocketEvent("ws.open", {
          sessionId: conn.sessionId,
          attempt,
          elapsedMs: Date.now() - createdAt,
          protocol: ws.protocol || undefined
        });
      };

	      ws.onmessage = (event) => {
	        if (canceled || socketRef.current !== ws) return;
	        if (!termRef.current) return;

        if (typeof event.data === "string") {
	          try {
	            const msg = JSON.parse(event.data);
	            if (msg?.type === "snapshot" && typeof msg.data === "string") {
	              const term = termRef.current;
	              if (!term) return;
	              const snapshotChars = msg.data.length;
	              term.reset();
	              term.write(msg.data, () => {
	                term.scrollToBottom();
	                atBottomRef.current = true;
	                setIsAtBottom(true);
	                scheduleScrollCheck();
	                emitSocketEvent("ws.snapshot", {
	                  sessionId: conn.sessionId,
	                  attempt,
	                  chars: snapshotChars
	                });
	              });
	            }
	            if (msg?.type === "exit") {
	              termRef.current.writeln(`\r\n[process exited]`);
	            }
          } catch {
            // ignore
          }
          return;
        }

        const bytes = new Uint8Array(event.data as ArrayBuffer);
        const text = bytesToBinaryString(bytes);
        termRef.current.write(text);
        scheduleScrollCheck();
        try {
          onOutputRef.current?.(text);
        } catch {
          // ignore
        }
      };

      ws.onerror = () => {
        const current = socketRef.current === ws;
        emitSocketEvent("ws.error", {
          sessionId: conn.sessionId,
          attempt,
          current,
          readyState: ws.readyState,
          elapsedMs: Date.now() - createdAt
        });
      };
      ws.onclose = (event) => {
        if (heartbeatTimer !== null) {
          window.clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        const current = socketRef.current === ws;
        emitSocketEvent("ws.close", {
          sessionId: conn.sessionId,
          attempt,
          current,
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          readyState: ws.readyState,
          elapsedMs: Date.now() - createdAt
        });
        if (!current || canceled || disconnectFired) return;
        disconnectFired = true;
        onDisconnectRef.current({
          opened,
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          elapsedMs: Date.now() - createdAt
        });
      };

      appleDictationRevisionRef.current.lastAt = 0;
      appleDictationRevisionRef.current.lastText = "";
      onDataDisposable = terminal.onData((data) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const deduped = maybeDedupeAppleDictationRevision(appleDictationRevisionRef.current, data);
        if (!deduped) return;
        ws.send(binaryStringToBytes(deduped));
      });
    }, 0);

    return () => {
      canceled = true;
      window.clearTimeout(connectTimer);
      onDataDisposable?.dispose();
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close(1000, "unmount");
        }
      } catch {
        // ignore
      }
      if (socketRef.current === ws) {
        socketRef.current = null;
      }
    };
  }, [conn, focusTerminal, scheduleScrollCheck]);

  return (
    <div className="terminalHost" onClick={focusTerminal} ref={hostRef}>
      <div ref={containerRef} className="terminalContainer" />
    <div
      className={[
        "terminalScrollScrubber",
        scrubberMetrics.visible ? "visible" : "",
        scrubberMetrics.visible && isScrubbing ? "scrubbing" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="terminalScrollScrubberButton"
        title="Jump to top"
        onClick={(event) => {
          event.stopPropagation();
          scrollToTop();
        }}
      >
        ↑
      </button>
      <div
        className="terminalScrollScrubberRail"
        ref={scrubberRailRef}
          onPointerDown={handleScrubberPointerDown}
          onPointerMove={handleScrubberPointerMove}
          onPointerUp={handleScrubberPointerUp}
          onPointerCancel={handleScrubberPointerUp}
        >
          <div
            className="terminalScrollScrubberThumb"
            aria-hidden="true"
            style={{
              height: `${scrubberMetrics.thumbHeight}px`,
              transform: `translateY(${scrubberMetrics.thumbTop}px)`
            }}
          />
        </div>
      </div>
      <div className="terminalMobileBar" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => sendSpecial("\u001b")}
          aria-label="Esc"
          title="Esc"
        >
          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-x.svg")} />
        </button>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => sendSpecial("\t")}
          aria-label="Tab"
          title="Tab"
        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton("ui-arrow-right-from-line.svg")}
          />
        </button>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => sendSpecial("\u0003")}
          aria-label="Ctrl+C"
          title="Ctrl+C"
        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton("ui-square-stop.svg")}
          />
        </button>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => sendSpecial("\u0015")}
          aria-label="Clear line"
          title="Clear line (Ctrl+U)"
        >
          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-trash-2.svg")} />
        </button>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => sendSpecial("\r")}
          aria-label="Enter"
          title="Enter"
        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton("ui-corner-down-left.svg")}
          />
        </button>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => void pasteFromClipboard()}
          aria-label="Paste"
          title="Paste"
        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton("ui-clipboard.svg")}
          />
        </button>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => sendSpecial("\u001b[B")}
          aria-label="Arrow down"
          title="Arrow down"
        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton("ui-arrow-down.svg")}
          />
        </button>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => sendSpecial("\u001b[D")}
          aria-label="Arrow left"
          title="Arrow left"
        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton("ui-arrow-left.svg")}
          />
        </button>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => sendSpecial("\u001b[C")}
          aria-label="Arrow right"
          title="Arrow right"
        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton("ui-arrow-right.svg")}
          />
        </button>
	        <button
	          type="button"
	          className="terminalMobileButton"
	          onClick={jumpToTop}
	          aria-label="Jump to top"
	          title="Jump to top"
	        >
	          <span
	            className="terminalMobileIcon"
	            aria-hidden="true"
	            style={maskStyleForSvgButton("ui-chevrons-up.svg")}
          />
        </button>
	        <button
	          type="button"
	          className="terminalMobileButton"
	          onClick={jumpToBottom}
	          aria-label="Jump to bottom"
	          title="Jump to bottom"
	        >
	          <span
	            className="terminalMobileIcon"
	            aria-hidden="true"
	            style={maskStyleForSvgButton("ui-chevrons-down.svg")}
          />
        </button>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => sendSpecial("\u001b[H")}
          aria-label="Home"
          title="Home"
        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton("ui-arrow-left-to-line.svg")}
          />
        </button>
        <button
          type="button"
          className="terminalMobileButton"
          onClick={() => sendSpecial("\u001b[F")}
          aria-label="End"
          title="End"
        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton("ui-arrow-right-to-line.svg")}
          />
        </button>
      </div>
      {!isAtBottom && (
        <div className="terminalScrollLock" onClick={(event) => event.stopPropagation()}>
          <span className="terminalScrollLockLabel">Scroll locked</span>
          <button type="button" className="terminalScrollLockButton" onClick={jumpToBottom}>
            Jump to bottom
          </button>
        </div>
      )}
    </div>
  );
});
