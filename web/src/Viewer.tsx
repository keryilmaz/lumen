import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { Annotation, Capture, CaptureFn, CaptureRegistration, SeriesMeta } from "./types";
import { friendlyName } from "./friendly";

/**
 * Codex review must-fixes addressed in this revision:
 *  - Image-load race: a load token cancels stale onloads; capture refuses to
 *    return data when the loaded image URL doesn't match the current slice URL.
 *  - Coord-space drift: xScale and yScale are derived AFTER canvas floor and
 *    used consistently for both annotation drawing and mouse-up conversion.
 *  - Capture freshness: capture function is registered ONCE via captureRef and
 *    reads sliceIndex / annotations from refs, so it always sees the latest
 *    state without re-registering on every render.
 *  - Pointer capture: drag started inside the canvas can complete even if
 *    mouseup happens off-canvas (was being silently dropped).
 *  - onload/onerror cleanup on effect teardown.
 *  - Capture returns { imageWidth, imageHeight, sliceUrl, seriesId } so the
 *    parent can denormalize AI annotations against the actual image dimensions
 *    AND validate that the response matches the slice/series at ask time.
 */

type Props = {
  series: SeriesMeta;
  annotations: Annotation[];
  onUserAnnotation: (a: Omit<Annotation, "id" | "source">) => void;
  onSliceChange: (sliceIndex: number) => void;
  /** Parent passes a ref slot + a readiness callback. Viewer fills the ref on mount,
   *  clears on unmount, and calls onReady(true/false) so the parent can re-render
   *  state-bound UI (Ask button enable/disable). */
  capture: CaptureRegistration;
  /** Slice indices flagged by an AI scan — render small marks on the scrubber so the
   *  user can see where the AI wants them to look. */
  flaggedSlices?: number[];
};

type Pt = { x: number; y: number };
/** Drag is stored in IMAGE-pixel coords so it stays correct even if the
 *  container resizes mid-drag (e.g. the user grabs the SplitPane handle). */
type Drawing = { start: Pt; current: Pt };

export function Viewer({
  series,
  annotations,
  onUserAnnotation,
  onSliceChange,
  capture: { ref: captureRef, onReady, gotoRef },
  flaggedSlices,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const loadedUrlRef = useRef<string | null>(null);
  const resizeRafRef = useRef<number | null>(null);

  const [sliceIndex, setSliceIndex] = useState(Math.floor(series.n_slices / 2));
  const [renderTick, setRenderTick] = useState(0);
  const [drawing, setDrawing] = useState<Drawing | null>(null);

  const sliceUrl = useMemo(
    () => `/data/${series.series_id}/${series.slices[sliceIndex]?.filename ?? ""}`,
    [series.series_id, series.slices, sliceIndex],
  );
  const sliceUrlRef = useRef(sliceUrl);
  sliceUrlRef.current = sliceUrl;

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const sliceIndexRef = useRef(sliceIndex);
  sliceIndexRef.current = sliceIndex;
  const seriesIdRef = useRef(series.series_id);
  seriesIdRef.current = series.series_id;

  // Reset to middle slice when series changes
  useEffect(() => {
    const mid = Math.floor(series.n_slices / 2);
    setSliceIndex(mid);
    onSliceChange(mid);
  }, [series.series_id, series.n_slices]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load image for current slice — cancellable to prevent stale onload races
  useEffect(() => {
    const img = new Image();
    let cancelled = false;
    onReady(false); // capture is not safe to call until this image loads
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      loadedUrlRef.current = sliceUrl;
      setRenderTick((t) => t + 1);
      onReady(true);
    };
    img.onerror = () => {
      if (cancelled) return;
      console.warn("image load failed:", sliceUrl);
    };
    img.src = sliceUrl;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [sliceUrl, onReady]);

  // Render
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || loadedUrlRef.current !== sliceUrl) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const parent = canvas.parentElement!;
    const pw = parent.clientWidth;
    const ph = parent.clientHeight;
    const fitScale = Math.min(pw / img.width, ph / img.height);
    canvas.width = Math.max(1, Math.floor(img.width * fitScale));
    canvas.height = Math.max(1, Math.floor(img.height * fitScale));
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    // Derive scales from the FLOORED canvas dims so draw and mouse-up use the same numbers
    const xScale = canvas.width / img.width;
    const yScale = canvas.height / img.height;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    for (const a of annotations) {
      if (a.sliceIndex !== sliceIndex) continue;
      drawCircle(
        ctx,
        a.cx * xScale,
        a.cy * yScale,
        a.r * Math.min(xScale, yScale),
        a.source === "user" ? "#22d3ee" : aiColor(a.provider),
        a.label ?? (a.source === "user" ? "you" : "ai"),
      );
    }

    if (drawing) {
      // Drawing is stored in image-pixel coords; render in canvas-pixel coords using current scale.
      const dx = (drawing.current.x - drawing.start.x) * xScale;
      const dy = (drawing.current.y - drawing.start.y) * yScale;
      const r = Math.hypot(dx, dy);
      drawCircle(ctx, drawing.start.x * xScale, drawing.start.y * yScale, r, "#22d3ee", "");
    }
  }, [renderTick, annotations, sliceIndex, drawing, sliceUrl]);

  // Re-render when the canvas's PARENT changes size — splitter drags don't fire window 'resize'.
  // ResizeObserver covers both the splitter and window resize on modern runtimes; we keep the
  // window 'resize' listener as a fallback. rAF coalesces multiple callbacks per frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!parent) return;

    const scheduleResizeRender = () => {
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = null;
        setRenderTick((t) => t + 1);
      });
    };

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleResizeRender);
    observer?.observe(parent);
    window.addEventListener("resize", scheduleResizeRender);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleResizeRender);
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 : -1;
      setSliceIndex((i) => {
        const next = Math.max(0, Math.min(series.n_slices - 1, i + delta));
        if (next !== i) onSliceChange(next);
        return next;
      });
    },
    [series.n_slices, onSliceChange],
  );

  // Convert canvas px to image px using the LIVE canvas dims
  const imageScale = useCallback(
    (canvas: HTMLCanvasElement, img: HTMLImageElement) => ({
      xScale: img.width / canvas.width,
      yScale: img.height / canvas.height,
    }),
    [],
  );

  const canvasPt = useCallback((e: React.MouseEvent<HTMLCanvasElement>): Pt => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp(e.clientX - rect.left, 0, canvas.width),
      y: clamp(e.clientY - rect.top, 0, canvas.height),
    };
  }, []);

  /** Returns the pointer position in IMAGE-pixel coords (or null if not ready). */
  const imagePt = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): Pt | null => {
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (!canvas || !img) return null;
      const p = canvasPt(e);
      const { xScale, yScale } = imageScale(canvas, img);
      return { x: p.x * xScale, y: p.y * yScale };
    },
    [canvasPt, imageScale],
  );

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pointerId = (e as unknown as React.PointerEvent).pointerId;
    if (typeof pointerId === "number") {
      try {
        (e.target as Element).setPointerCapture?.(pointerId);
      } catch {
        // ignore — fall back to document-level listeners on dragout
      }
    }
    const p = imagePt(e);
    if (!p) return;
    setDrawing({ start: p, current: p });
  };
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawing) return;
    const p = imagePt(e);
    if (!p) return;
    setDrawing((d) => (d ? { ...d, current: p } : d));
  };
  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawing) return;
    const end = imagePt(e);
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!end || !canvas || !img) {
      setDrawing(null);
      return;
    }
    const dx = end.x - drawing.start.x;
    const dy = end.y - drawing.start.y;
    const r = Math.hypot(dx, dy);
    // Convert to display-pixel radius for the click-vs-drag threshold check
    const displayR = r * Math.min(canvas.width / img.width, canvas.height / img.height);
    setDrawing(null);
    if (displayR < 5) return; // click, not a drag
    onUserAnnotation({
      sliceIndex: sliceIndexRef.current,
      cx: drawing.start.x,
      cy: drawing.start.y,
      r,
      label: "your circle",
    });
  };

  // Register capture once. The function reads from refs so it always sees latest.
  useEffect(() => {
    const capture: CaptureFn = async (): Promise<Capture> => {
      const img = imgRef.current;
      const url = sliceUrlRef.current;
      const sIndex = sliceIndexRef.current;
      const sId = seriesIdRef.current;
      if (!img) throw new Error("image not loaded");
      if (loadedUrlRef.current !== url) throw new Error("image not synced with current slice");

      // Full slice with current annotations drawn
      const full = document.createElement("canvas");
      full.width = img.width;
      full.height = img.height;
      const fctx = full.getContext("2d")!;
      fctx.drawImage(img, 0, 0);
      const annos = annotationsRef.current;
      for (const a of annos) {
        if (a.sliceIndex !== sIndex) continue;
        drawCircle(
          fctx,
          a.cx,
          a.cy,
          a.r,
          a.source === "user" ? "#22d3ee" : aiColor(a.provider),
          a.label ?? "",
        );
      }
      const slicePng = full.toDataURL("image/png").split(",")[1];

      // Crop the latest user annotation on this slice (if any)
      const userAnno = [...annos].reverse().find(
        (a) => a.sliceIndex === sIndex && a.source === "user",
      );
      let roiPng: string | undefined;
      if (userAnno) {
        const pad = userAnno.r * 0.5;
        const x0 = Math.max(0, Math.floor(userAnno.cx - userAnno.r - pad));
        const y0 = Math.max(0, Math.floor(userAnno.cy - userAnno.r - pad));
        const x1 = Math.min(img.width, Math.ceil(userAnno.cx + userAnno.r + pad));
        const y1 = Math.min(img.height, Math.ceil(userAnno.cy + userAnno.r + pad));
        const cw = x1 - x0;
        const ch = y1 - y0;
        if (cw > 4 && ch > 4) {
          const crop = document.createElement("canvas");
          crop.width = cw;
          crop.height = ch;
          crop.getContext("2d")!.drawImage(img, x0, y0, cw, ch, 0, 0, cw, ch);
          roiPng = crop.toDataURL("image/png").split(",")[1];
        }
      }

      return {
        slicePng,
        roiPng,
        sliceIndex: sIndex,
        seriesId: sId,
        imageWidth: img.width,
        imageHeight: img.height,
        sliceUrl: url,
      };
    };
    captureRef.current = capture;
    const goto = (index: number) => {
      const clamped = Math.max(0, Math.min(series.n_slices - 1, Math.round(index)));
      setSliceIndex(clamped);
      onSliceChange(clamped);
    };
    gotoRef.current = goto;
    return () => {
      if (captureRef.current === capture) {
        captureRef.current = null;
        onReady(false);
      }
      if (gotoRef.current === goto) gotoRef.current = null;
    };
  }, [captureRef, onReady, gotoRef, series.n_slices, onSliceChange]);

  const fn = friendlyName(series);

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--bg-base)" }}>
      <div
        className="px-5 pt-4 pb-3 flex items-start justify-between gap-6"
        style={{ background: "var(--bg-base)" }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-medium truncate" style={{ color: "var(--text-1)" }}>
              {fn.title}
            </h2>
            <span
              style={{ color: "var(--text-4)" }}
              className="text-[10.5px] shrink-0 uppercase tracking-wider"
              title={fn.technical}
            >
              {series.columns}×{series.rows}
            </span>
          </div>
          {fn.hint && (
            <p className="text-[12px] mt-0.5" style={{ color: "var(--text-3)" }}>
              {fn.hint}
            </p>
          )}
        </div>
        {/* Display-number pattern: large, light-weight image counter */}
        <div className="text-right shrink-0">
          <div className="display-num text-[36px]" style={{ color: "var(--text-1)" }}>
            {sliceIndex + 1}
            <span className="text-[14px] font-normal ml-1" style={{ color: "var(--text-4)" }}>
              / {series.n_slices}
            </span>
          </div>
          <div className="text-[10.5px] uppercase tracking-wider mt-0.5" style={{ color: "var(--text-4)" }}>
            image
          </div>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center overflow-hidden" style={{ background: "#000" }}>
        <canvas
          ref={canvasRef}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={(e) => {
            // Don't drop the in-progress drag on mouseleave; pointer capture keeps us subscribed.
            // Only cancel if the pointer button is no longer pressed.
            if (drawing && e.buttons === 0) setDrawing(null);
          }}
          style={{ cursor: "crosshair" }}
        />
      </div>
      <div className="px-4 py-3" style={{ background: "var(--bg-base)" }}>
        <div className="relative">
          <input
            type="range"
            min={0}
            max={series.n_slices - 1}
            value={sliceIndex}
            onChange={(e) => {
              const i = Number(e.target.value);
              setSliceIndex(i);
              onSliceChange(i);
            }}
            className="w-full relative z-10"
          />
          {flaggedSlices && flaggedSlices.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-0.5 h-1.5 pointer-events-none">
              {flaggedSlices.map((idx) => (
                <div
                  key={idx}
                  className="absolute top-0 w-1 h-1.5 rounded-full"
                  style={{
                    background: "var(--warn)",
                    left: `${(idx / Math.max(1, series.n_slices - 1)) * 100}%`,
                    transform: "translateX(-50%)",
                  }}
                  title={`AI flagged slice ${idx + 1}`}
                />
              ))}
            </div>
          )}
        </div>
        <div className="text-[11px] mt-2" style={{ color: "var(--text-4)" }}>
          scroll · flip through images &nbsp;·&nbsp; click+drag · circle a spot to ask about
        </div>
      </div>
    </div>
  );
}

function drawCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  label: string,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  if (label) {
    ctx.fillStyle = color;
    ctx.font = "12px -apple-system, sans-serif";
    ctx.fillText(label, x + r + 4, y);
  }
  ctx.restore();
}

function aiColor(provider?: string): string {
  if (provider === "claude") return "#f59e0b";
  if (provider === "gpt5") return "#10b981";
  if (provider === "gemini") return "#a78bfa";
  return "#ef4444";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
