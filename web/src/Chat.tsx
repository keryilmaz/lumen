import { useEffect, useRef, useState } from "react";
import type {
  ChatTurn,
  ComparisonEvidence,
  ComparisonFindingStatus,
  Finding,
  Provider,
  ProgressionCompareHistoryItem,
  ProgressionCompareJob,
  ProgressionCompareResult,
  ScanPhase,
  ScanReportMeta,
} from "./types";

type Props = {
  history: ChatTurn[];
  busy: boolean;
  provider: Provider;
  setProvider: (p: Provider) => void;
  onAsk: (question: string) => void;
  askDisabled?: boolean;
  onScan?: () => void;
  onJumpToSlice?: (sliceIndex: number) => void;
  onJumpToEvidence?: (seriesKey: string, sliceIndex: number) => void;
  scanPhase?: ScanPhase;
  scanReport?: ScanReportMeta | null;
  scanTargetLabel?: string;
  onCreateReport?: () => void;
  createReportDisabled?: boolean;
  reportJob?: ProgressionCompareJob | null;
  timelineReport?: ProgressionCompareResult | null;
  reportHistory?: ProgressionCompareHistoryItem[];
  matchingSavedReportId?: string | null;
  onLoadReport?: (resultId: string) => void;
  onExportReport?: (resultId: string) => void;
  onDeleteReport?: (resultId: string) => void;
  selectedDateCount?: number;
};

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  notable: "notable",
  "worth-asking": "worth asking",
  "clearly-physiologic": "likely normal",
};
const SEVERITY_DOT_COLOR: Record<Finding["severity"], string> = {
  notable: "var(--notable)",
  "worth-asking": "var(--worth)",
  "clearly-physiologic": "var(--physiologic)",
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
  gpt5: "GPT-5.5",
  gemini: "Gemini",
};

const PROVIDER_DOT_COLOR: Record<Provider, string> = {
  claude: "#facc15",
  gpt5: "#34d399",
  gemini: "#a78bfa",
};

const PROVIDER_TEXT_COLOR: Record<Provider, string> = {
  claude: "#fde68a",
  gpt5: "#a7f3d0",
  gemini: "#ddd6fe",
};

function reportDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function reportStudyLabel(item: ProgressionCompareHistoryItem): string {
  return item.studies.map((study) => study.studyDate || study.studyLabel).join(" → ");
}

export function Chat({
  history,
  busy,
  provider,
  setProvider,
  onAsk,
  askDisabled,
  onScan,
  onJumpToSlice,
  onJumpToEvidence,
  scanPhase = "idle",
  scanReport,
  scanTargetLabel = "selected view",
  onCreateReport,
  createReportDisabled,
  reportJob,
  timelineReport,
  reportHistory = [],
  matchingSavedReportId,
  onLoadReport,
  onExportReport,
  onDeleteReport,
  selectedDateCount = 0,
}: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const scanRunning = busy && scanPhase !== "idle" && scanPhase !== "done";
  const reportRunning = reportJob?.status === "queued" || reportJob?.status === "running";
  const reportPercent = Math.max(0, Math.min(100, reportJob?.progress?.percent ?? 0));
  const currentSavedReportLoaded = !!timelineReport && !!matchingSavedReportId && timelineReport.resultId === matchingSavedReportId;
  const reportButtonLabel = reportRunning
    ? "Creating…"
    : matchingSavedReportId
      ? currentSavedReportLoaded
        ? "Loaded"
        : "Load saved report"
      : "Create report";

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
      {/* Header — compact model selector. */}
      <div className="px-5 pt-5 pb-3 flex items-center justify-between gap-3">
        <span className="ui-label">AI model</span>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
          className="ui-control ui-control-select shrink-0 min-w-[96px]"
          title="AI model"
        >
          {(["claude", "gpt5", "gemini"] as Provider[]).map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABEL[p]}
            </option>
          ))}
        </select>
      </div>

      {/* Durable scan/report actions: save Markdown notes that future chat turns can reuse. */}
      {onScan && (
        <div className="px-5 py-3">
          <div className="ui-card-cream px-5 py-4 space-y-3">
            <div className="flex items-start justify-between gap-3 mb-1">
              <div className="min-w-0">
                <h3 className="ui-title">
                  {scanPhase === "idle" || scanPhase === "done"
                    ? "Scan selected view"
                    : PHASE_COPY[scanPhase].label}
                </h3>
                {(scanPhase === "idle" || scanPhase === "done") && (
                  <div className="ui-caption mt-1">
                    {scanReport
                      ? `Saved note for ${scanTargetLabel}`
                      : `Currently scanning: ${scanTargetLabel}`}
                  </div>
                )}
              </div>
              <button
                onClick={onScan}
                disabled={busy}
                className="ui-control ui-control-on-cream shrink-0"
              >
                {scanRunning ? "Scanning…" : scanPhase === "done" ? "Scan again" : "Scan selected view"}
              </button>
            </div>
            {scanPhase !== "idle" && scanPhase !== "done" && (
              <div className="flex items-center gap-1">
                {(["survey", "zoom", "deep"] as const).map((p) => {
                  const active = scanPhase === p;
                  const past =
                    (scanPhase === "zoom" && p === "survey") ||
                    (scanPhase === "deep" && (p === "survey" || p === "zoom"));
                  return (
                    <div
                      key={p}
                      className="h-0.5 flex-1 rounded-full"
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
            {scanPhase === "done" && scanReport && (
              <div
                className="ui-caption pt-3"
                style={{ borderTop: "1px solid rgba(20, 23, 26, 0.16)" }}
                title={scanReport.latestPath}
              >
                Markdown saved. Future questions about this scan use the latest note automatically.
              </div>
            )}
            {onCreateReport && (
              <div className="pt-3 space-y-3" style={{ borderTop: "1px solid rgba(20, 23, 26, 0.16)" }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="ui-title">Timeline report</h3>
                    <div className="ui-caption mt-1">
                      {selectedDateCount >= 2
                        ? `${selectedDateCount} selected dates · ${scanTargetLabel}`
                        : `Select at least two dates for ${scanTargetLabel}`}
                    </div>
                  </div>
                  <button
                    onClick={onCreateReport}
                    disabled={busy || createReportDisabled || currentSavedReportLoaded}
                    className="ui-control ui-control-on-cream shrink-0"
                  >
                    {reportButtonLabel}
                  </button>
                </div>
                {reportJob && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between ui-caption">
                      <span>{reportJob.progress.detail ?? "Creating timeline report"}</span>
                      <span>{reportPercent.toFixed(0)}%</span>
                    </div>
                    <div className="ui-progress-track" style={{ background: "rgba(20, 23, 26, 0.2)" }}>
                      <div
                        className="ui-progress-bar"
                        style={{ width: `${reportPercent}%`, background: "var(--highlight-ink)" }}
                      />
                    </div>
                  </div>
                )}
                {timelineReport?.latestPath && (
                  <div className="ui-caption" title={timelineReport.latestPath}>
                    Timeline Markdown saved. Future questions about this scan type use the latest report automatically.
                  </div>
                )}
                {reportHistory.length > 0 && (
                  <div className="space-y-2">
                    <div className="ui-label">Saved report history</div>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {reportHistory.map((item) => {
                        const loaded = timelineReport?.resultId === item.resultId;
                        const exact = matchingSavedReportId === item.resultId;
                        return (
                          <div
                            key={item.resultId}
                            className="flex items-stretch gap-1.5"
                            title={item.reportPath ?? item.latestPath}
                          >
                            <button
                              type="button"
                              onClick={() => onLoadReport?.(item.resultId)}
                              disabled={busy || loaded}
                              className="ui-control flex-1 min-w-0 justify-between text-left disabled:opacity-60"
                            >
                              <span className="min-w-0">
                                <span className="block truncate">
                                  {reportDateLabel(item.createdAt)}
                                  {exact ? " · current dates" : ""}
                                </span>
                                <span className="block truncate ui-caption">
                                  {reportStudyLabel(item) || `${item.groupCount} visible-change groups`}
                                </span>
                              </span>
                              <span className="shrink-0">{loaded ? "loaded" : "load"}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onExportReport?.(item.resultId)}
                              disabled={busy}
                              className="ui-control shrink-0"
                              title="Download saved Markdown report"
                            >
                              export
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteReport?.(item.resultId)}
                              disabled={busy}
                              className="ui-control shrink-0"
                              title="Delete saved report"
                              style={{ color: "rgb(252,165,165)" }}
                            >
                              delete
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Conversation — flex-1 + min-h-0 so overflow-y-auto actually scrolls inside the flex column */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-5 pb-3 space-y-5">
        {history.length === 0 && (
          <div className="ui-caption py-2">
            No conversation yet.
          </div>
        )}
        {history.map((turn, i) => (
          <ChatBubble
            key={i}
            turn={turn}
            onJumpToSlice={onJumpToSlice}
            onJumpToEvidence={onJumpToEvidence}
          />
        ))}
        {busy && (
          <div className="flex items-center gap-2 ui-caption">
            <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: PROVIDER_DOT_COLOR[provider] }} />
            <span style={{ color: PROVIDER_TEXT_COLOR[provider] }}>{PROVIDER_LABEL[provider]} is looking…</span>
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
            className="ui-field flex-1 min-w-0 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || askDisabled || !input.trim()}
            className="ui-control shrink-0"
            title={askDisabled ? "Image still loading…" : undefined}
          >
            Ask
          </button>
        </form>
      </div>
    </div>
  );
}

function ChatBubble({
  turn,
  onJumpToSlice,
  onJumpToEvidence,
}: {
  turn: ChatTurn;
  onJumpToSlice?: (i: number) => void;
  onJumpToEvidence?: (seriesKey: string, sliceIndex: number) => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="ui-chat-bubble">
          {turn.content}
          {typeof turn.sliceIndex === "number" && (
            <div className="ui-caption mt-1">image {turn.sliceIndex + 1}</div>
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
      <div className="flex items-center gap-2 ui-caption">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: turn.provider ? PROVIDER_DOT_COLOR[turn.provider] : "var(--text-4)" }}
        />
        <span style={{ color: turn.provider ? PROVIDER_TEXT_COLOR[turn.provider] : "var(--text-3)" }}>
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
      <div className="ui-body whitespace-pre-wrap leading-relaxed" style={{ color: "var(--text-1)" }}>
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

      {turn.progressionCompare && turn.progressionCompare.groups.length > 0 && (
        <div className="space-y-2 pt-1">
          {turn.progressionCompare.groups.map((group) => (
            <ComparisonGroupCard
              key={group.groupId}
              group={group}
              onJumpToEvidence={onJumpToEvidence}
            />
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
                className="ui-control group"
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
        <div className="ui-caption">
          marked {turn.annotations.length} spot{turn.annotations.length > 1 ? "s" : ""} on image{" "}
          {(turn.annotations[0].sliceIndex ?? 0) + 1}
        </div>
      )}
    </div>
  );
}

const COMPARE_STATUS_LABEL: Record<ComparisonFindingStatus, string> = {
  seen_across_dates: "flagged across scans",
  later_date_only: "latest scan only",
  earlier_date_only: "not matched on latest",
  changed_appearance_or_extent: "changed across scans",
  uncertain_match: "uncertain match",
};

const COMPARE_STATUS_COLOR: Record<ComparisonFindingStatus, string> = {
  seen_across_dates: "var(--physiologic)",
  later_date_only: "var(--notable)",
  earlier_date_only: "var(--worth)",
  changed_appearance_or_extent: "var(--worth)",
  uncertain_match: "var(--text-3)",
};

function ComparisonGroupCard({
  group,
  onJumpToEvidence,
}: {
  group: NonNullable<ChatTurn["progressionCompare"]>["groups"][number];
  onJumpToEvidence?: (seriesKey: string, sliceIndex: number) => void;
}) {
  const [expanded, setExpanded] = useState(
    group.status === "later_date_only" || group.status === "changed_appearance_or_extent",
  );
  return (
    <div className="ui-surface overflow-hidden">
      <div className="flex items-stretch">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-start gap-3 px-4 py-4 flex-1 text-left min-w-0"
        >
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
            style={{ background: COMPARE_STATUS_COLOR[group.status] }}
          />
          <div className="min-w-0 flex-1">
            <div className="ui-label mb-1">{COMPARE_STATUS_LABEL[group.status]}</div>
            <h3 className="ui-title truncate">{group.title}</h3>
            {!expanded && (
              <p className="ui-body truncate mt-1">{group.visibleChangeSummary}</p>
            )}
          </div>
          <div className="ui-caption shrink-0">
            {group.evidence.length} date{group.evidence.length === 1 ? "" : "s"}
          </div>
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="px-3.5 ui-caption"
          style={{ color: "var(--text-3)", borderLeft: "1px solid var(--stroke)" }}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
      </div>
      {expanded && (
        <div className="px-4 pb-4 space-y-3.5 ui-body">
          <Section label="Plain-English meaning">
            <p style={{ color: "var(--text-1)" }}>{group.visibleChangeSummary}</p>
          </Section>
          <Section label="Scan dates and images">
            <div className="flex flex-wrap gap-1.5">
              {group.evidence.map((e) => (
                <EvidencePill
                  key={`${e.seriesKey}-${e.sliceIndex}-${e.region}`}
                  evidence={e}
                  onJumpToEvidence={onJumpToEvidence}
                />
              ))}
            </div>
          </Section>
          <Section label="Ask the oncologist">
            <ul className="space-y-1 list-disc ml-4" style={{ color: "var(--text-1)" }}>
              {group.oncologistQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </Section>
          <div className="ui-caption">
            {(group.confidence * 100).toFixed(0)}% average AI confidence · visual review only
          </div>
        </div>
      )}
    </div>
  );
}

function EvidencePill({
  evidence,
  onJumpToEvidence,
}: {
  evidence: ComparisonEvidence;
  onJumpToEvidence?: (seriesKey: string, sliceIndex: number) => void;
}) {
  return (
    <button
      onClick={() => onJumpToEvidence?.(evidence.seriesKey, evidence.sliceIndex)}
      className="ui-control"
      title={`${evidence.studyLabel} · image ${evidence.sliceIndex + 1}`}
    >
      <span className="truncate max-w-[120px]">{evidence.studyDate || evidence.studyLabel}</span>
      <span className="font-mono opacity-80">#{evidence.sliceIndex + 1}</span>
    </button>
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
      className="ui-surface overflow-hidden"
    >
      {/* Header — large display image-number on the right, like the reference dashboard cards */}
      <div className="flex items-stretch">
        <button
          onClick={() => onJumpToSlice?.(finding.sliceIndex)}
          className="flex items-baseline gap-3 px-4 pt-4 pb-3 flex-1 text-left min-w-0"
          title={`Jump to image ${finding.sliceIndex + 1}`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: SEVERITY_DOT_COLOR[finding.severity] }}
              />
              <span className="ui-label">
                {SEVERITY_LABEL[finding.severity]}
              </span>
            </div>
            <h3 className="ui-title truncate">
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
          className="px-3.5 ui-caption"
          style={{ color: "var(--text-3)", borderLeft: "1px solid var(--stroke)" }}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
      </div>

      {/* Collapsed: 1-line observation summary */}
      {!expanded && (
        <div
          className="px-4 pb-4 ui-body truncate"
        >
          {finding.observation}
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 space-y-3.5 ui-body">
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
          <div className="flex items-center justify-between ui-caption pt-1">
            <span>{(finding.confidence * 100).toFixed(0)}% confidence</span>
            <button
              onClick={() => onJumpToSlice?.(finding.sliceIndex)}
              className="ui-inline-action"
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
      <div className="ui-label mb-1.5">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
