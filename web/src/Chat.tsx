import { useEffect, useRef, useState } from "react";
import type { ChatTurn, Finding, Provider, SeriesMeta, ScanPhase } from "./types";

type Props = {
  /** Kept in the contract so callers don't have to change shape if Chat ever
   *  needs the active series again; currently unused (the active series name
   *  is rendered in the main app header tab strip, not in Chat). */
  series?: SeriesMeta;
  history: ChatTurn[];
  busy: boolean;
  provider: Provider;
  setProvider: (p: Provider) => void;
  onAsk: (question: string) => void;
  askDisabled?: boolean;
  onScan?: () => void;
  onJumpToSlice?: (sliceIndex: number) => void;
  scanPhase?: ScanPhase;
};

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  notable: "notable",
  "worth-asking": "worth asking",
  "clearly-physiologic": "likely normal",
};
const SEVERITY_DOT: Record<Finding["severity"], string> = {
  notable: "bg-rose-400",
  "worth-asking": "bg-amber-400",
  "clearly-physiologic": "bg-neutral-400",
};

const PHASE_COPY: Record<Exclude<ScanPhase, "idle" | "done">, { label: string; sub: string }> = {
  survey: {
    label: "Surveying the whole scan…",
    sub: "Looking at 16 evenly-spaced images to find regions worth a closer look.",
  },
  zoom: {
    label: "Zooming into regions of interest…",
    sub: "Sampling more images around each flagged area to confirm or drop it.",
  },
  deep: {
    label: "Deep-diving on top regions…",
    sub: "Examining every image in the most notable areas for the final read.",
  },
};

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude",
  gpt5: "GPT-5",
  gemini: "Gemini",
};

const PROVIDER_DOT: Record<Provider, string> = {
  claude: "bg-amber-400",
  gpt5: "bg-emerald-400",
  gemini: "bg-violet-400",
};

const PROVIDER_TEXT: Record<Provider, string> = {
  claude: "text-amber-300",
  gpt5: "text-emerald-300",
  gemini: "text-violet-300",
};

export function Chat({
  history,
  busy,
  provider,
  setProvider,
  onAsk,
  askDisabled,
  onScan,
  onJumpToSlice,
  scanPhase = "idle",
}: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [history.length, busy]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || busy || askDisabled) return;
    setInput("");
    onAsk(q);
  };

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: "var(--bg-base)" }}>
      {/* Header — provider switcher rendered as flat text with active underline,
          matching the dashboard reference's restrained chrome. */}
      <div
        className="px-5 pt-5 pb-3 flex items-center justify-between gap-3"
        style={{ background: "var(--bg-base)" }}
      >
        <span style={{ color: "var(--text-3)" }} className="text-[11px] uppercase tracking-wider">
          AI model
        </span>
        <div className="flex gap-4 shrink-0">
          {(["claude", "gpt5", "gemini"] as Provider[]).map((p) => {
            const active = provider === p;
            return (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className="flex items-center gap-1.5 text-[12.5px] transition-colors whitespace-nowrap pb-1"
                style={{
                  color: active ? "var(--text-1)" : "var(--text-3)",
                  borderBottom: active
                    ? `1px solid var(--text-1)`
                    : "1px solid transparent",
                }}
                title={`Use ${PROVIDER_LABEL[p]}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PROVIDER_DOT[p]}`} />
                {PROVIDER_LABEL[p]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Disclaimer — quieter, single line, no fill */}
      <div
        className="px-5 py-2 text-[11.5px] flex items-start gap-2"
        style={{ color: "var(--text-3)", borderTop: "1px solid var(--stroke)" }}
      >
        <span style={{ color: "var(--warn)" }}>▲</span>
        <span>
          Not medical advice. A tool to prepare questions for the oncology team — not a diagnosis.
        </span>
      </div>

      {/* Scan CTA — cream highlight card with outlined pill action.
          Matches the reference dashboard's primary call-to-action pattern. */}
      {onScan && (
        <div className="px-5 py-3">
          <div
            className="rounded-2xl px-5 py-4"
            style={{ background: "var(--highlight)", color: "var(--highlight-ink)" }}
          >
            <div className="flex items-start justify-between gap-3 mb-1">
              <h3 className="text-[15px] font-medium leading-tight">
                {scanPhase === "idle" || scanPhase === "done"
                  ? "Look for cancer signs"
                  : PHASE_COPY[scanPhase].label}
              </h3>
              <button
                onClick={onScan}
                disabled={busy}
                className="shrink-0 inline-flex items-center gap-1 text-[12px] px-3 py-1 rounded-full transition-colors disabled:opacity-50"
                style={{
                  border: `1px solid rgba(20, 23, 26, 0.4)`,
                  color: "var(--highlight-ink)",
                  background: busy ? "rgba(20, 23, 26, 0.06)" : "transparent",
                }}
              >
                {busy ? "Scanning…" : scanPhase === "done" ? "Run again" : "Run scan"}
              </button>
            </div>
            <p className="text-[12.5px]" style={{ color: "var(--highlight-mute)" }}>
              {scanPhase === "idle" || scanPhase === "done"
                ? `Three-pass deep scan with ${PROVIDER_LABEL[provider]}. Surveys the whole series, zooms into regions of interest, examines every image in the top areas.`
                : PHASE_COPY[scanPhase].sub}
            </p>
            {scanPhase !== "idle" && scanPhase !== "done" && (
              <div className="flex items-center gap-1 mt-3">
                {(["survey", "zoom", "deep"] as const).map((p) => {
                  const active = scanPhase === p;
                  const past =
                    (scanPhase === "zoom" && p === "survey") ||
                    (scanPhase === "deep" && (p === "survey" || p === "zoom"));
                  return (
                    <div
                      key={p}
                      className="h-0.5 flex-1 rounded-full transition-colors"
                      style={{
                        background: active
                          ? "var(--highlight-ink)"
                          : past
                            ? "rgba(20, 23, 26, 0.5)"
                            : "rgba(20, 23, 26, 0.15)",
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Conversation — flex-1 + min-h-0 so overflow-y-auto actually scrolls inside the flex column */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-5 pb-3 space-y-5">
        {history.length === 0 && (
          <div className="text-[13px] py-2" style={{ color: "var(--text-3)" }}>
            <p style={{ color: "var(--text-2)" }} className="mb-2">Two ways to start:</p>
            <ol className="space-y-1.5 ml-4 list-decimal">
              <li>
                Tap <span style={{ color: "var(--accent)" }}>Look for cancer signs across all images</span>{" "}
                — the AI does a 3-pass deep scan: surveys the whole series, zooms into regions of
                interest, then examines every image in the top areas. Each finding lists what it could
                mean, how a healthy scan compares, and questions to ask the oncologist.
              </li>
              <li>
                Or scroll to a specific image, draw a circle around something you're curious about, and
                ask <span style={{ color: "var(--text-2)" }}>"what is this?"</span>
              </li>
            </ol>
            <p className="mt-3 text-[11.5px]" style={{ color: "var(--text-4)" }}>
              The 3-pass scan takes 1–2 minutes and uses your AI API quota.
            </p>
          </div>
        )}
        {history.map((turn, i) => (
          <ChatBubble key={i} turn={turn} onJumpToSlice={onJumpToSlice} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-[12px]" style={{ color: PROVIDER_TEXT[provider] === undefined ? "var(--text-3)" : "" }}>
            <span className={`w-2 h-2 rounded-full animate-pulse ${PROVIDER_DOT[provider]}`} />
            <span className={PROVIDER_TEXT[provider]}>{PROVIDER_LABEL[provider]} is looking…</span>
          </div>
        )}
      </div>

      {/* Composer — flush at the bottom, pill input + outline pill button */}
      <div
        className="px-5 py-3"
        style={{
          background: "var(--bg-base)",
          borderTop: "1px solid var(--stroke)",
        }}
      >
        <form onSubmit={submit} className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about this image…"
            disabled={busy}
            className="flex-1 rounded-full px-4 py-2.5 text-[13.5px] focus:outline-none disabled:opacity-50"
            style={{ background: "var(--bg-2)", color: "var(--text-1)" }}
          />
          <button
            type="submit"
            disabled={busy || askDisabled || !input.trim()}
            className="rounded-full px-4 py-2 text-[12.5px] transition-colors disabled:cursor-not-allowed shrink-0"
            style={{
              border: `1px solid ${busy || askDisabled || !input.trim() ? "var(--text-4)" : "var(--text-2)"}`,
              color: busy || askDisabled || !input.trim() ? "var(--text-4)" : "var(--text-1)",
              background: "transparent",
            }}
            title={askDisabled ? "Image still loading…" : undefined}
          >
            Ask
          </button>
        </form>
      </div>
    </div>
  );
}

function ChatBubble({ turn, onJumpToSlice }: { turn: ChatTurn; onJumpToSlice?: (i: number) => void }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[85%] rounded-2xl px-3.5 py-2 text-[14px] whitespace-pre-wrap"
          style={{ background: "var(--bg-3)", color: "var(--text-1)" }}
        >
          {turn.content}
          {typeof turn.sliceIndex === "number" && (
            <div className="text-[11px] mt-1" style={{ color: "var(--text-4)" }}>image {turn.sliceIndex + 1}</div>
          )}
        </div>
      </div>
    );
  }
  const phaseLabels: Record<string, string> = {
    survey: "Survey",
    zoom: "Zoom",
    deep: "Deep dive",
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[12px]">
        <span className={`w-1.5 h-1.5 rounded-full ${turn.provider ? PROVIDER_DOT[turn.provider] : "bg-neutral-500"}`} />
        <span className={turn.provider ? PROVIDER_TEXT[turn.provider] : "text-neutral-400"}>
          {turn.provider ? PROVIDER_LABEL[turn.provider] : "ai"}
        </span>
        {turn.scanPhase && (
          <span style={{ color: "var(--text-4)" }}>
            · {phaseLabels[turn.scanPhase.phase] ?? turn.scanPhase.phase}
            {turn.scanPhase.findings && ` · ${turn.scanPhase.findings.length} finding${turn.scanPhase.findings.length === 1 ? "" : "s"}`}
            {typeof turn.scanPhase.roiCount === "number" &&
              ` · ${turn.scanPhase.roiCount} region${turn.scanPhase.roiCount === 1 ? "" : "s"}`}
          </span>
        )}
        {turn.scan && (
          <span style={{ color: "var(--text-4)" }}>
            · looked at {turn.scan.sampledIndices.length} images, marked {turn.scan.flagged.length}
          </span>
        )}
      </div>
      <div className="text-[14px] whitespace-pre-wrap leading-relaxed" style={{ color: "var(--text-1)" }}>
        {turn.content}
      </div>

      {/* Three-pass scan: render structured findings as expandable cards. */}
      {turn.scanPhase?.findings && turn.scanPhase.findings.length > 0 && (
        <div className="space-y-2 pt-1">
          {turn.scanPhase.findings
            .slice()
            .sort((a, b) => a.sliceIndex - b.sliceIndex)
            .map((f) => (
              <FindingCard key={f.id} finding={f} onJumpToSlice={onJumpToSlice} />
            ))}
        </div>
      )}

      {/* Legacy single-pass scan compatibility — chips only. */}
      {turn.scan && turn.scan.flagged.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {turn.scan.flagged
            .slice()
            .sort((a, b) => a.sliceIndex - b.sliceIndex)
            .map((f, i) => (
              <button
                key={`${f.sliceIndex}-${i}`}
                onClick={() => onJumpToSlice?.(f.sliceIndex)}
                className="group text-[12px] px-2.5 py-1 rounded-full transition-colors flex items-center gap-1.5"
                style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
                title={`Jump to image ${f.sliceIndex + 1} · ${(f.confidence * 100).toFixed(0)}% confidence`}
              >
                <span className="font-mono opacity-80">#{f.sliceIndex + 1}</span>
                <span style={{ color: "var(--text-1)" }} className="group-hover:underline">
                  {f.label}
                </span>
              </button>
            ))}
        </div>
      )}

      {!turn.scan && !turn.scanPhase && turn.annotations && turn.annotations.length > 0 && (
        <div className="text-[11px]" style={{ color: "var(--text-4)" }}>
          marked {turn.annotations.length} spot{turn.annotations.length > 1 ? "s" : ""} on image{" "}
          {(turn.annotations[0].sliceIndex ?? 0) + 1}
        </div>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  onJumpToSlice,
}: {
  finding: Finding;
  onJumpToSlice?: (i: number) => void;
}) {
  const [expanded, setExpanded] = useState(finding.severity === "notable");
  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: "var(--bg-1)" }}
    >
      {/* Header — large display image-number on the right, like the reference dashboard cards */}
      <div className="flex items-stretch">
        <button
          onClick={() => onJumpToSlice?.(finding.sliceIndex)}
          className="flex items-baseline gap-3 px-4 pt-4 pb-3 flex-1 text-left hover:bg-white/[0.02] transition-colors min-w-0"
          title={`Jump to image ${finding.sliceIndex + 1}`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${SEVERITY_DOT[finding.severity]}`} />
              <span className="text-[10.5px] uppercase tracking-wider" style={{ color: "var(--text-4)" }}>
                {SEVERITY_LABEL[finding.severity]}
              </span>
            </div>
            <h3 className="text-[14px] font-medium truncate" style={{ color: "var(--text-1)" }}>
              {finding.region}
            </h3>
          </div>
          <div className="display-num text-[28px] shrink-0" style={{ color: "var(--text-1)" }}>
            <span style={{ color: "var(--text-4)" }} className="text-[14px] font-normal mr-1">
              #
            </span>
            {finding.sliceIndex + 1}
          </div>
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="px-3.5 hover:bg-white/[0.02] transition-colors text-[12px]"
          style={{ color: "var(--text-3)", borderLeft: "1px solid var(--stroke)" }}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
      </div>

      {/* Collapsed: 1-line observation summary */}
      {!expanded && (
        <div
          className="px-4 pb-4 text-[12.5px] leading-snug truncate"
          style={{ color: "var(--text-2)" }}
        >
          {finding.observation}
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 space-y-3.5 text-[12.5px]" style={{ color: "var(--text-2)" }}>
          <Section label="What I see">
            <p style={{ color: "var(--text-1)" }}>{finding.observation}</p>
          </Section>
          <Section label="What this pattern can mean">
            <ul className="space-y-1 list-disc ml-4">
              {finding.possibleMeanings.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Section>
          <Section label="In a healthy scan, this area usually">
            <p>{finding.healthyComparison}</p>
          </Section>
          <Section label="Ask the oncologist">
            <ul className="space-y-1 list-disc ml-4" style={{ color: "var(--text-1)" }}>
              {finding.questionsForOncologist.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </Section>
          <div className="flex items-center justify-between text-[11px] pt-1" style={{ color: "var(--text-4)" }}>
            <span>{(finding.confidence * 100).toFixed(0)}% confidence</span>
            <button
              onClick={() => onJumpToSlice?.(finding.sliceIndex)}
              className="hover:underline"
              style={{ color: "var(--text-2)" }}
            >
              jump to image {finding.sliceIndex + 1} →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] mb-1.5" style={{ color: "var(--text-4)" }}>
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
