import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * Resizable two-pane split with a draggable vertical handle.
 * Codex-generated implementation; preserves panel size in localStorage and
 * supports keyboard a11y (left/right arrow steps the divider, Home/End jump
 * to min/max). Dispatches a synthetic window resize after each size change so
 * the canvas-based viewer's ResizeObserver picks it up.
 */
type SplitPaneProps = {
  left: ReactNode;
  right: ReactNode;
  min?: number;
  max?: number;
  defaultSize?: number;
  storageKey?: string;
  collapsed?: boolean;
};

const LEFT_MIN = 240;
const HANDLE_WIDTH = 6;
const DEFAULT_MIN = 320;
const DEFAULT_MAX = 720;
const DEFAULT_SIZE = 420;

const canUseWindow = typeof window !== "undefined";

function clamp(value: number, min: number, max: number, containerWidth: number) {
  const effectiveMax = Math.max(
    min,
    Math.min(max, containerWidth > 0 ? containerWidth - LEFT_MIN - HANDLE_WIDTH : max),
  );
  return Math.min(Math.max(value, min), effectiveMax);
}

function readInitialSize(storageKey: string | undefined, defaultSize: number) {
  if (!canUseWindow || !storageKey) return defaultSize;
  const stored = window.localStorage.getItem(storageKey);
  if (!stored) return defaultSize;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? parsed : defaultSize;
}

function dispatchResize() {
  if (!canUseWindow) return;
  window.dispatchEvent(new Event("resize"));
}

export function SplitPane({
  left,
  right,
  min = DEFAULT_MIN,
  max = DEFAULT_MAX,
  defaultSize = DEFAULT_SIZE,
  storageKey,
  collapsed = false,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef(readInitialSize(storageKey, defaultSize));
  const frameRef = useRef<number | null>(null);
  const pendingSizeRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [size, setSize] = useState(() => clamp(sizeRef.current, min, max, 0));

  const persist = useCallback(
    (nextSize: number) => {
      if (!canUseWindow || !storageKey) return;
      window.localStorage.setItem(storageKey, String(Math.round(nextSize)));
    },
    [storageKey],
  );

  const applySize = useCallback(
    (nextSize: number, shouldPersist = false) => {
      const clamped = clamp(nextSize, min, max, containerWidth);
      sizeRef.current = clamped;
      setSize(clamped);
      dispatchResize();
      if (shouldPersist) persist(clamped);
      return clamped;
    },
    [containerWidth, max, min, persist],
  );

  const scheduleSize = useCallback(
    (nextSize: number) => {
      pendingSizeRef.current = nextSize;
      if (frameRef.current !== null || !canUseWindow) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (pendingSizeRef.current === null) return;
        applySize(pendingSizeRef.current);
        pendingSizeRef.current = null;
      });
    },
    [applySize],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const width = entry?.contentRect.width ?? 0;
      setContainerWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    applySize(sizeRef.current);
  }, [applySize]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null && canUseWindow) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const startDrag = (clientX: number) => {
    draggingRef.current = true;
    const startX = clientX;
    const startSize = sizeRef.current;
    const onPointerMove = (event: PointerEvent) => {
      const delta = startX - event.clientX;
      scheduleSize(startSize + delta);
    };
    const stopDrag = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
      if (pendingSizeRef.current !== null) {
        applySize(pendingSizeRef.current, true);
        pendingSizeRef.current = null;
      } else {
        persist(sizeRef.current);
        dispatchResize();
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
  };

  const onHandlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    startDrag(event.clientX);
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextSize: number | null = null;
    if (event.key === "ArrowLeft") nextSize = sizeRef.current + 16;
    if (event.key === "ArrowRight") nextSize = sizeRef.current - 16;
    if (event.key === "Home") nextSize = min;
    if (event.key === "End") nextSize = max;
    if (nextSize === null) return;
    event.preventDefault();
    applySize(nextSize, true);
  };

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: "flex", background: "var(--bg-base)" }}
    >
      <div className="min-w-0 flex-1 overflow-hidden" style={{ flex: "1 1 auto" }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(size)}
        tabIndex={collapsed ? -1 : 0}
        onPointerDown={onHandlePointerDown}
        onKeyDown={onHandleKeyDown}
        className="h-full shrink-0 cursor-col-resize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        style={{
          display: collapsed ? "none" : "block",
          width: HANDLE_WIDTH,
          flex: `0 0 ${HANDLE_WIDTH}px`,
          background: "rgba(255,255,255,0.04)",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = "rgba(255,255,255,0.10)";
        }}
        onMouseLeave={(event) => {
          if (!draggingRef.current) event.currentTarget.style.background = "rgba(255,255,255,0.04)";
        }}
      />
      <div
        className="min-w-0 overflow-hidden"
        style={{
          display: collapsed ? "none" : "block",
          flex: `0 0 ${size}px`,
        }}
      >
        {right}
      </div>
    </div>
  );
}
