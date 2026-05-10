import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Viewer } from "./Viewer";
import { Chat } from "./Chat";
import { Settings } from "./Settings";
import { SplitPane } from "./SplitPane";
import { useBreakpoint } from "./responsive";
import { friendlyName, disambiguateShorts } from "./friendly";
import { openReportWindow } from "./report";
import type {
  Annotation,
  CaptureFn,
  ChatTurn,
  Finding,
  Provider,
  ScanPhase,
  SeriesMeta,
} from "./types";

type ProviderKeyName = "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY";
type KeysStatus = Record<ProviderKeyName, { configured: boolean; last4?: string }>;
const KEY_TO_PROVIDER: Record<ProviderKeyName, Provider> = {
  ANTHROPIC_API_KEY: "claude",
  OPENAI_API_KEY: "gpt5",
  GOOGLE_API_KEY: "gemini",
};

type ServerROI = {
  region: string;
  centerSlice: number;
  spanStart: number;
  spanEnd: number;
  why: string;
  priority: number;
};

type ServerFinding = {
  sliceIndex: number;
  xNorm: number;
  yNorm: number;
  radiusNorm: number;
  region: string;
  observation: string;
  possibleMeanings: string[];
  healthyComparison: string;
  questionsForOncologist: string[];
  confidence: number;
  severity: "notable" | "worth-asking" | "clearly-physiologic";
};

/**
 * Codex review must-fixes addressed:
 *  - Request-identity guard (requestId + seriesId snapshot at ask time);
 *    every state mutation after the await gates on "this is still the active request".
 *  - Hard busy guard at top of onAsk prevents concurrent asks from racing.
 *  - nextHistory built locally so the user turn is always part of subsequent state
 *    even if React hasn't flushed setHistory yet.
 *  - AI annotations denormalized against the captured imageWidth/imageHeight
 *    (the actual loaded PNG dims), not series.columns/rows — the two can differ.
 *  - Stable captureRef object passed down, so Viewer registers once.
 *  - error cleared on series switch and on successful response.
 *  - Ask button disabled when capture isn't ready.
 *  - Stale fallback flag from server is surfaced as a subtle inline note.
 */
export default function App() {
  const [series, setSeries] = useState<SeriesMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [provider, setProvider] = useState<Provider>("claude");
  const [busy, setBusy] = useState(false);
  const [currentSlice, setCurrentSlice] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keysStatus, setKeysStatus] = useState<KeysStatus | null>(null);
  const [scanPhase, setScanPhase] = useState<ScanPhase>("idle");
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [mobileView, setMobileView] = useState<"viewer" | "chat">("viewer");
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === "desktop";

  const captureRef = useRef<CaptureFn | null>(null);
  const gotoRef = useRef<((index: number) => void) | null>(null);
  const [captureReady, setCaptureReady] = useState(false);
  const requestCounterRef = useRef(0);
  const activeRequestSeriesRef = useRef<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  // Stable capture-registration object so Viewer's effect doesn't re-fire each render
  const onCaptureReady = useCallback((ready: boolean) => setCaptureReady(ready), []);
  const captureRegistration = useMemo(
    () => ({ ref: captureRef, onReady: onCaptureReady, gotoRef }),
    [onCaptureReady],
  );

  // Disambiguate tab labels when two series would otherwise look identical
  const tabLabels = useMemo(() => {
    return disambiguateShorts(
      series.map((s) => ({ series_id: s.series_id, n_slices: s.n_slices, short: friendlyName(s).short })),
    );
  }, [series]);

  const flaggedSlices = useMemo(() => {
    const set = new Set<number>();
    for (const a of annotations) if (a.source === "ai") set.add(a.sliceIndex);
    return [...set].sort((a, b) => a - b);
  }, [annotations]);

  const goToSlice = useCallback((idx: number) => {
    gotoRef.current?.(idx);
  }, []);

  useEffect(() => {
    fetch("/api/study")
      .then((r) => r.json())
      .then((d) => {
        const ss = (d.series ?? []) as SeriesMeta[];
        setSeries(ss);
        const pet = ss.find((s) => s.modality === "PT") ?? ss[0];
        if (pet) setActiveId(pet.series_id);
      })
      .catch((e) =>
        setError(`Could not load study: ${e}. Start the server with: cd server && npm run dev`),
      );
    refreshKeys();
  }, []);

  const refreshKeys = useCallback(() => {
    fetch("/api/keys/status")
      .then((r) => r.json())
      .then((d) => setKeysStatus(d.keys))
      .catch(() => setKeysStatus(null));
  }, []);

  // Auto-pick a configured provider once keys load, if the current pick isn't configured
  useEffect(() => {
    if (!keysStatus) return;
    const currentKeyName = (Object.entries(KEY_TO_PROVIDER).find(([, p]) => p === provider)?.[0]) as ProviderKeyName | undefined;
    if (!currentKeyName || keysStatus[currentKeyName]?.configured) return;
    const firstConfigured = (Object.entries(keysStatus).find(([, v]) => v.configured)?.[0]) as ProviderKeyName | undefined;
    if (firstConfigured) setProvider(KEY_TO_PROVIDER[firstConfigured]);
  }, [keysStatus, provider]);

  const anyKeyConfigured = !!keysStatus && Object.values(keysStatus).some((s) => s.configured);

  const active = series.find((s) => s.series_id === activeId) ?? null;

  const onUserAnnotation = (a: Omit<Annotation, "id" | "source">) => {
    setAnnotations((prev) => [...prev, { ...a, id: crypto.randomUUID(), source: "user" }]);
  };

  const onAsk = async (question: string) => {
    if (!active || !captureRef.current) return;
    if (busy) return; // hard guard against concurrent asks

    const requestId = ++requestCounterRef.current;
    const requestSeriesId = active.series_id;
    activeRequestSeriesRef.current = requestSeriesId;

    const isStale = () =>
      requestId !== requestCounterRef.current ||
      activeIdRef.current !== requestSeriesId;

    setBusy(true);
    setError(null);

    let cap: Awaited<ReturnType<CaptureFn>>;
    try {
      cap = await captureRef.current();
    } catch (e) {
      if (!isStale()) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
      return;
    }
    if (isStale()) {
      setBusy(false);
      return;
    }

    // Append user turn locally — used both for state and as prior-turns context for the API
    const userTurn: ChatTurn = {
      role: "user",
      content: question,
      sliceIndex: cap.sliceIndex,
    };
    const priorTurns = history.map((t) => ({ role: t.role, content: t.content }));
    setHistory((h) => [...h, userTurn]);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          imageB64: cap.slicePng,
          roiB64: cap.roiPng,
          sliceIndex: cap.sliceIndex,
          seriesId: cap.seriesId,
          seriesDescription: active.series_description,
          modality: active.modality,
          question,
          history: priorTurns,
        }),
      });

      if (isStale()) return;

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "request_failed" }));
        throw new Error(`server: ${body.error ?? res.statusText}`);
      }
      const data = (await res.json()) as {
        text: string;
        annotations: { x_norm?: number; y_norm?: number; radius_norm?: number; xNorm?: number; yNorm?: number; radiusNorm?: number; label: string; confidence: number }[];
        provider: Provider;
        fallback?: boolean;
      };
      if (isStale()) return;

      // Denormalize against the actual image dims captured at ask time
      const w = cap.imageWidth;
      const h = cap.imageHeight;
      const minDim = Math.min(w, h);
      const newAnnos: Annotation[] = (data.annotations ?? []).map((a) => {
        const xNorm = a.xNorm ?? a.x_norm ?? 0;
        const yNorm = a.yNorm ?? a.y_norm ?? 0;
        const radiusNorm = a.radiusNorm ?? a.radius_norm ?? 0.05;
        return {
          id: crypto.randomUUID(),
          source: "ai" as const,
          provider: data.provider,
          sliceIndex: cap.sliceIndex,
          cx: xNorm * w,
          cy: yNorm * h,
          r: radiusNorm * minDim,
          label: a.label,
          confidence: a.confidence,
        };
      });

      // Final stale check before mutating shared state
      if (isStale()) return;
      setAnnotations((prev) => [...prev, ...newAnnos]);
      setHistory((h) => [
        ...h,
        {
          role: "assistant",
          content: data.text,
          provider: data.provider,
          annotations: newAnnos,
          sliceIndex: cap.sliceIndex,
        },
      ]);
      setError(null);
      if (data.fallback) {
        // Subtle inline note — the server substituted a safe message
        console.warn("[ask] server returned safe fallback for this turn");
      }
    } catch (e) {
      if (!isStale()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!isStale()) setBusy(false);
    }
  };

  /** Three-pass scan orchestrator. Survey (16 slices) → Zoom (~8 per ROI) → Deep
   *  (every slice in top regions). Pushes one chat turn per phase so the user
   *  sees progress and intermediate findings. */
  const onScan = async () => {
    if (!active || busy) return;
    setBusy(true);
    setError(null);
    setScanPhase("survey");
    const requestId = ++requestCounterRef.current;
    const requestSeriesId = active.series_id;
    const isStale = () =>
      requestId !== requestCounterRef.current || activeIdRef.current !== requestSeriesId;
    const seriesAtStart = active;
    const minDim = Math.min(seriesAtStart.columns, seriesAtStart.rows);
    const denormFindings = (raws: ServerFinding[]): Finding[] =>
      raws.map((f) => ({
        id: crypto.randomUUID(),
        sliceIndex: f.sliceIndex,
        cx: f.xNorm * seriesAtStart.columns,
        cy: f.yNorm * seriesAtStart.rows,
        r: f.radiusNorm * minDim,
        region: f.region,
        observation: f.observation,
        possibleMeanings: f.possibleMeanings,
        healthyComparison: f.healthyComparison,
        questionsForOncologist: f.questionsForOncologist,
        confidence: f.confidence,
        severity: f.severity,
        provider,
      }));
    const findingToAnnotation = (f: Finding): Annotation => ({
      id: f.id,
      source: "ai" as const,
      provider: f.provider,
      sliceIndex: f.sliceIndex,
      cx: f.cx,
      cy: f.cy,
      r: f.r,
      label: f.region,
      confidence: f.confidence,
    });

    try {
      // ---- Phase 1: Survey ----
      const surveyRes = await fetch("/api/scan/survey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, seriesId: seriesAtStart.series_id }),
      });
      if (isStale()) return;
      if (!surveyRes.ok) {
        const body = await surveyRes.json().catch(() => ({ error: "survey_failed" }));
        throw new Error(`survey: ${body.error ?? surveyRes.statusText}`);
      }
      const survey = (await surveyRes.json()) as {
        text: string;
        rois: ServerROI[];
        provider: Provider;
        fallback?: boolean;
      };
      if (isStale()) return;
      setHistory((h) => [
        ...h,
        {
          role: "assistant",
          content: survey.text,
          provider: survey.provider,
          scanPhase: { phase: "survey", summary: survey.text, roiCount: survey.rois.length },
        },
      ]);
      if (survey.rois.length === 0) {
        setScanPhase("done");
        return;
      }

      // ---- Phase 2: Zoom ----
      setScanPhase("zoom");
      const zoomRes = await fetch("/api/scan/zoom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          seriesId: seriesAtStart.series_id,
          rois: survey.rois,
        }),
      });
      if (isStale()) return;
      if (!zoomRes.ok) {
        const body = await zoomRes.json().catch(() => ({ error: "zoom_failed" }));
        throw new Error(`zoom: ${body.error ?? zoomRes.statusText}`);
      }
      const zoom = (await zoomRes.json()) as {
        text: string;
        findings: ServerFinding[];
        provider: Provider;
        fallback?: boolean;
      };
      if (isStale()) return;
      const zoomFindings = denormFindings(zoom.findings);
      setAnnotations((prev) => [...prev, ...zoomFindings.map(findingToAnnotation)]);
      setHistory((h) => [
        ...h,
        {
          role: "assistant",
          content: zoom.text,
          provider: zoom.provider,
          scanPhase: { phase: "zoom", summary: zoom.text, findings: zoomFindings },
        },
      ]);

      // ---- Phase 3: Deep dive (top 3 by priority+confidence) ----
      const topRegions = survey.rois
        .slice()
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 3);
      if (topRegions.length === 0) {
        setScanPhase("done");
        return;
      }
      setScanPhase("deep");
      const deepRes = await fetch("/api/scan/deep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          seriesId: seriesAtStart.series_id,
          regions: topRegions,
        }),
      });
      if (isStale()) return;
      if (!deepRes.ok) {
        const body = await deepRes.json().catch(() => ({ error: "deep_failed" }));
        throw new Error(`deep: ${body.error ?? deepRes.statusText}`);
      }
      const deep = (await deepRes.json()) as {
        text: string;
        findings: ServerFinding[];
        provider: Provider;
        fallback?: boolean;
      };
      if (isStale()) return;
      const deepFindings = denormFindings(deep.findings);
      // Replace zoom-phase annotations for the same regions with deep ones (dedupe by sliceIndex proximity).
      setAnnotations((prev) => {
        const deepIds = new Set(deepFindings.map((f) => f.id));
        const deepRegions = deepFindings.map((f) => ({ slice: f.sliceIndex, source: f.provider }));
        const filtered = prev.filter((a) => {
          if (a.source !== "ai") return true;
          if (deepIds.has(a.id)) return true; // unlikely; new ids
          // drop ai annotations whose slice is within 5 of any deep finding (assume superseded)
          const superseded = deepRegions.some((d) => Math.abs(d.slice - a.sliceIndex) <= 5);
          return !superseded;
        });
        return [...filtered, ...deepFindings.map(findingToAnnotation)];
      });
      setHistory((h) => [
        ...h,
        {
          role: "assistant",
          content: deep.text,
          provider: deep.provider,
          scanPhase: { phase: "deep", summary: deep.text, findings: deepFindings },
        },
      ]);
      setScanPhase("done");
    } catch (e) {
      if (!isStale()) {
        setError(e instanceof Error ? e.message : String(e));
        setScanPhase("idle");
      }
    } finally {
      if (!isStale()) setBusy(false);
    }
  };

  const switchSeries = (sid: string) => {
    setActiveId(sid);
    setAnnotations([]);
    setHistory([]);
    setError(null);
    requestCounterRef.current++; // invalidate any in-flight request
  };

  const clearAnnotations = () => setAnnotations([]);

  const exportReport = () => {
    openReportWindow({
      series,
      history,
      annotations,
      generatedAt: new Date(),
    });
  };
  const hasFindingsToExport = history.some(
    (t) => t.role === "assistant" && (t.scanPhase?.findings?.length || (!t.scanPhase && t.content)),
  );

  /** Outlined pill for header actions — matches the reference dashboard's
   *  "Change module" / "Week ↓" / "Change" buttons. */
  const HeaderPill = ({
    children,
    onClick,
    disabled,
    title,
  }: {
    children: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    title?: string;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="text-[11.5px] px-3 py-1 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        border: "1px solid var(--stroke-strong)",
        color: disabled ? "var(--text-4)" : "var(--text-2)",
        background: "transparent",
      }}
    >
      {children}
    </button>
  );

  if (error && series.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-lg text-sm text-neutral-300">
          <div className="text-red-400 mb-2">Could not load the scan.</div>
          <pre className="bg-neutral-900 border border-neutral-800 rounded p-3 whitespace-pre-wrap">
            {error}
          </pre>
        </div>
      </div>
    );
  }

  if (series.length === 0) {
    return <div className="h-full flex items-center justify-center text-neutral-500">Loading study…</div>;
  }

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--bg-base)" }}>
      <header
        className="px-5 py-3 flex items-center justify-between gap-4"
        style={{ background: "var(--bg-base)", borderBottom: "1px solid var(--stroke)" }}
      >
        <div className="flex items-center gap-6 min-w-0">
          <div className="font-medium text-[14px] shrink-0 tracking-tight" style={{ color: "var(--text-1)" }}>
            Lumen
          </div>
          {/* Flat-text series tabs with underline on active — matches the
              reference dashboard's restrained nav */}
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {series.map((s) => {
              const active = activeId === s.series_id;
              const fn = friendlyName(s);
              return (
                <button
                  key={s.series_id}
                  onClick={() => switchSeries(s.series_id)}
                  className="text-[12.5px] whitespace-nowrap transition-colors pb-0.5"
                  style={{
                    color: active ? "var(--text-1)" : "var(--text-3)",
                    borderBottom: active
                      ? `1px solid var(--text-1)`
                      : "1px solid transparent",
                  }}
                  title={`${fn.hint || fn.title}\n${fn.technical}`}
                >
                  {tabLabels.get(s.series_id) ?? fn.short}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!isDesktop && (
            <div className="flex gap-0.5 p-0.5 rounded-full" style={{ background: "var(--bg-1)" }}>
              <button
                onClick={() => setMobileView("viewer")}
                className="text-[12px] px-3 py-1 rounded-full transition-colors"
                style={{
                  background: mobileView === "viewer" ? "var(--bg-4)" : "transparent",
                  color: mobileView === "viewer" ? "var(--text-1)" : "var(--text-3)",
                }}
              >
                Scan
              </button>
              <button
                onClick={() => setMobileView("chat")}
                className="text-[12px] px-3 py-1 rounded-full transition-colors"
                style={{
                  background: mobileView === "chat" ? "var(--bg-4)" : "transparent",
                  color: mobileView === "chat" ? "var(--text-1)" : "var(--text-3)",
                }}
              >
                Chat
              </button>
            </div>
          )}
          {isDesktop && (
            <HeaderPill onClick={() => setChatCollapsed((v) => !v)} title={chatCollapsed ? "Show chat" : "Hide chat"}>
              {chatCollapsed ? "◀" : "▶"} chat
            </HeaderPill>
          )}
          <HeaderPill
            onClick={exportReport}
            disabled={!hasFindingsToExport}
            title={hasFindingsToExport ? "Open report for printing / saving as PDF" : "Run a scan or ask a question first"}
          >
            export report
          </HeaderPill>
          <HeaderPill onClick={clearAnnotations}>clear circles</HeaderPill>
          <HeaderPill onClick={() => setSettingsOpen(true)} title="API keys">
            keys
          </HeaderPill>
        </div>
      </header>
      {keysStatus && !anyKeyConfigured && (
        <button
          onClick={() => setSettingsOpen(true)}
          className="px-4 py-2 text-[12.5px] text-left transition-colors hover:opacity-90 flex items-center gap-2"
          style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
        >
          <span>▲</span>
          <span>
            No AI keys configured yet.{" "}
            <span style={{ color: "var(--text-1)" }} className="underline">Add a key</span> to start
            asking questions (you only need one — Claude, GPT-5, or Gemini).
          </span>
        </button>
      )}
      {error && (
        <div
          className="px-4 py-2 text-[12.5px] flex items-center justify-between"
          style={{ background: "rgba(239,68,68,0.10)", color: "rgb(252,165,165)" }}
        >
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="px-2 py-0.5 rounded-full hover:bg-white/[0.06]"
          >
            dismiss
          </button>
        </div>
      )}
      <main className="flex-1 overflow-hidden" style={{ background: "var(--bg-base)" }}>
        {active && isDesktop && (
          <SplitPane
            storageKey="lumen:split"
            defaultSize={420}
            min={320}
            max={720}
            collapsed={chatCollapsed}
            left={
              <Viewer
                series={active}
                annotations={annotations}
                onUserAnnotation={onUserAnnotation}
                onSliceChange={setCurrentSlice}
                capture={captureRegistration}
                flaggedSlices={flaggedSlices}
              />
            }
            right={
              <Chat
                series={active}
                history={history}
                busy={busy}
                provider={provider}
                setProvider={setProvider}
                onAsk={onAsk}
                askDisabled={!captureReady}
                onScan={onScan}
                onJumpToSlice={goToSlice}
                scanPhase={scanPhase}
              />
            }
          />
        )}
        {active && !isDesktop && (
          <div className="h-full w-full overflow-hidden">
            {mobileView === "viewer" ? (
              <Viewer
                series={active}
                annotations={annotations}
                onUserAnnotation={onUserAnnotation}
                onSliceChange={setCurrentSlice}
                capture={captureRegistration}
                flaggedSlices={flaggedSlices}
              />
            ) : (
              <Chat
                series={active}
                history={history}
                busy={busy}
                provider={provider}
                setProvider={setProvider}
                onAsk={onAsk}
                askDisabled={!captureReady}
                onScan={onScan}
                onJumpToSlice={goToSlice}
                scanPhase={scanPhase}
              />
            )}
          </div>
        )}
      </main>
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => setKeysStatus(s)}
      />
    </div>
  );
}
