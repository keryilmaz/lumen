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
  ImportInspection,
  ImportVolume,
  Provider,
  ProgressionCompareHistoryItem,
  ProgressionCompareJob,
  ProgressionCompareResult,
  ScanPhase,
  ScanReportMeta,
  SeriesMeta,
  StudyMeta,
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

type ScanReportPayload = {
  survey: {
    text: string;
    rois: ServerROI[];
    sampledIndices?: number[];
  };
  zoom?: {
    text: string;
    findings: ServerFinding[];
    inspectedIndices?: number[];
  };
  deep?: {
    text: string;
    findings: ServerFinding[];
    inspectedIndices?: number[];
  };
};

type ImportProgress = {
  phase: "queued" | "running" | "completed" | "failed";
  percent: number;
  currentItem?: string;
  detail?: string;
  seriesIndex?: number;
  totalSeries?: number;
  converted?: number;
  totalImages?: number;
};

type ImportJobState = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  studyId: string;
  studyLabel: string;
  error?: string;
  progress?: ImportProgress;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeTextForMatchClient(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function matchGroupKeyForSeries(seriesMeta: Pick<SeriesMeta, "modality" | "series_description">): string {
  return `${String(seriesMeta.modality ?? "").trim().toUpperCase() || "UNKNOWN"}::${normalizeTextForMatchClient(
    seriesMeta.series_description,
  )}`;
}

function sameStudySelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function downloadTextFile(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function safeDownloadName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "lumen-report";
}

/** Outlined pill for header actions — matches the dashboard reference's
 *  "Change module" / "Week ↓" style. Defined at module scope so React's
 *  static-components rule is happy. */
function HeaderPill({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="ui-control whitespace-nowrap"
    >
      {children}
    </button>
  );
}

function SidePanelToggle({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  const title = collapsed ? "Open side panel" : "Close side panel";
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="ui-control ui-control-icon"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10.5 3.5V12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        {collapsed ? (
          <path d="M6.2 6L8.2 8L6.2 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M8 6L6 8L8 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </button>
  );
}

function ImportCdPanel({
  onImported,
  framed = true,
}: {
  onImported: () => Promise<void>;
  framed?: boolean;
}) {
  const [volumes, setVolumes] = useState<ImportVolume[]>([]);
  const [customPath, setCustomPath] = useState("");
  const [inspection, setInspection] = useState<ImportInspection | null>(null);
  const [label, setLabel] = useState("");
  const [inspectBusy, setInspectBusy] = useState(false);
  const [job, setJob] = useState<ImportJobState | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const jobRunning = job?.status === "queued" || job?.status === "running";

  const loadVolumes = useCallback(async () => {
    const res = await fetch("/api/import/volumes");
    if (!res.ok) throw new Error("volume scan failed");
    const data = (await res.json()) as { volumes: ImportVolume[] };
    const nextVolumes = data.volumes ?? [];
    setVolumes(nextVolumes);
    return nextVolumes;
  }, []);

  useEffect(() => {
    loadVolumes().catch(() => setVolumes([]));
  }, [loadVolumes]);

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const timer = window.setInterval(async () => {
      const res = await fetch(`/api/import/jobs/${job.jobId}`);
      if (!res.ok) return;
      const next = (await res.json()) as ImportJobState;
      setJob(next);
      if (next.status === "completed") {
        window.clearInterval(timer);
        setMessage("Import complete.");
        onImported().catch(() => undefined);
      }
      if (next.status === "failed") {
        window.clearInterval(timer);
        setMessage(next.error ?? "Import failed.");
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [job, onImported]);

  const inspectSource = useCallback(async (pathToInspect: string) => {
    const res = await fetch("/api/import/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pathToInspect.trim() }),
    });
    if (!res.ok) throw new Error("Could not inspect that disc or folder.");
    return (await res.json()) as ImportInspection;
  }, []);

  const startImportFromInspection = useCallback(
    async (source: ImportInspection, force: boolean, labelOverride?: string) => {
      setMessage(null);
      try {
        const res = await fetch("/api/import/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: source.path,
            studyLabel: labelOverride || label || source.suggested_label,
            studyDate: source.study_date ?? "",
            force,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (data.error === "duplicate_study") {
            setMessage(`Already imported as ${data.duplicate?.label ?? "an existing study"}.`);
            return;
          }
          throw new Error(data.error ?? "Import failed to start.");
        }
        setJob({
          jobId: data.jobId,
          status: "queued",
          studyId: data.studyId,
          studyLabel: data.studyLabel,
          progress: {
            phase: "queued",
            percent: 0,
            detail: "Queued",
          },
        });
        setMessage(`Import started from ${source.volume_name || "the connected CD"}.`);
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
      }
    },
    [label],
  );

  const inspectPath = async (pathToInspect: string) => {
    if (!pathToInspect.trim()) return;
    setInspectBusy(true);
    setInspection(null);
    setJob(null);
    setMessage(null);
    try {
      const data = await inspectSource(pathToInspect);
      setInspection(data);
      setLabel(data.suggested_label);
      if (data.duplicate) {
        setMessage(`Already imported as ${data.duplicate.label}.`);
      } else {
        setMessage("Disc inspected. Review the label, then import.");
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setInspectBusy(false);
    }
  };

  const startImport = async (force: boolean) => {
    if (!inspection) return;
    await startImportFromInspection(inspection, force);
  };

  const checkConnectedCd = useCallback(async (importAfterInspection: boolean) => {
    if (inspectBusy || jobRunning) return;
    setInspectBusy(true);
    setInspection(null);
    setJob(null);
    setMessage("Checking the connected CD...");
    try {
      const nextVolumes = await loadVolumes();
      const dicomVolumes = nextVolumes.filter((v) => v.name !== "Macintosh HD" && v.hasImagesDir);
      if (dicomVolumes.length === 0) {
        setMessage("No DICOM CD found. Insert the disc, wait for it to appear in Finder, then refresh.");
        return;
      }
      if (dicomVolumes.length > 1) {
        setMessage("Found more than one DICOM disc. Pick the right one below.");
        return;
      }
      const [disc] = dicomVolumes;
      setMessage(`Found ${disc.name}. Reading scan date...`);
      const data = await inspectSource(disc.path);
      setInspection(data);
      setLabel(data.suggested_label);
      if (data.duplicate) {
        setMessage(`Already imported as ${data.duplicate.label}.`);
        return;
      }
      if (importAfterInspection) {
        setMessage("Importing the scan images...");
        await startImportFromInspection(data, false, data.suggested_label);
      } else {
        setMessage(`Ready to import ${data.suggested_label}.`);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setInspectBusy(false);
    }
  }, [inspectBusy, inspectSource, jobRunning, loadVolumes, startImportFromInspection]);

  const refreshConnectedCd = useCallback(() => {
    void checkConnectedCd(false);
  }, [checkConnectedCd]);

  const importFromConnectedCd = useCallback(() => {
    void checkConnectedCd(true);
  }, [checkConnectedCd]);

  const visibleVolumes = volumes.filter((v) => v.name !== "Macintosh HD");
  const dicomVolumeCount = visibleVolumes.filter((v) => v.hasImagesDir).length;
  const progressPercent = Math.max(
    0,
    Math.min(
      100,
      Math.round(job?.progress?.percent ?? (job?.status === "completed" ? 100 : jobRunning ? 1 : 0)),
    ),
  );
  const duplicateLabel = inspection?.duplicate
    ? `Already in dataset as ${inspection.duplicate.label}`
    : null;
  const progressTitle =
    (duplicateLabel ? "Already in dataset" : null) ??
    (job?.status === "completed"
      ? "Import complete"
      : job?.status === "failed"
        ? "Import failed"
        : jobRunning
          ? "Importing scan images"
          : inspectBusy
            ? "Checking connected CD"
            : null);
  const progressDetail =
    (duplicateLabel ? `Stored as ${inspection?.duplicate?.label}` : null) ??
    (job?.progress?.currentItem
      ? `${job.progress.currentItem}${job.progress.detail ? ` · ${job.progress.detail}` : ""}`
      : job?.progress?.detail ?? message);

  return (
    <div className={framed ? "ui-surface p-4" : ""}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="ui-title">
            Connected CD
          </div>
          <div className="ui-caption">
            {dicomVolumeCount > 0
              ? `${dicomVolumeCount} DICOM disc${dicomVolumeCount === 1 ? "" : "s"} found`
              : "Finds the scan disc attached to this Mac"}
          </div>
        </div>
        <button
          onClick={refreshConnectedCd}
          disabled={inspectBusy || jobRunning}
          className="ui-control"
        >
          {inspectBusy ? "checking..." : "refresh"}
        </button>
      </div>
      <button
        onClick={importFromConnectedCd}
        disabled={inspectBusy || jobRunning}
        className="ui-control ui-control-primary w-full"
      >
        {inspectBusy ? "Finding the connected CD..." : jobRunning ? "Import running..." : "Import from connected CD"}
      </button>
      {progressTitle && (
        <div className="ui-surface-raised mt-3 p-3">
          <div className="flex items-start gap-3">
            <div
              className="ui-status-icon mt-0.5"
              style={{
                background:
                  inspection?.duplicate || job?.status === "completed"
                    ? "var(--highlight)"
                    : job?.status === "failed"
                      ? "rgba(239,68,68,0.18)"
                      : "var(--bg-4)",
                color:
                  inspection?.duplicate || job?.status === "completed"
                    ? "var(--highlight-ink)"
                    : job?.status === "failed"
                      ? "rgb(252,165,165)"
                      : "var(--text-1)",
              }}
            >
              {inspection?.duplicate || job?.status === "completed" ? "✓" : job?.status === "failed" ? "!" : "…"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div className="ui-title truncate">
                  {progressTitle}
                </div>
                {job && (
                  <div className="ui-caption shrink-0">
                    {progressPercent}%
                  </div>
                )}
              </div>
              {progressDetail && (
                <div className="ui-caption mt-1 line-clamp-2">
                  {progressDetail}
                </div>
              )}
              {job && (
                <div className="ui-progress-track mt-2">
                  <div
                    className="ui-progress-bar"
                    style={{
                      width: `${progressPercent}%`,
                      background: job.status === "failed" ? "rgb(252,165,165)" : "var(--highlight)",
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="space-y-2">
        <details className="mt-3">
          <summary className="ui-caption cursor-pointer">
            Manual options
          </summary>
          <div className="mt-3 space-y-2">
            {visibleVolumes.map((v) => {
              const isInspectedVolume = inspection?.path === v.path;
              const alreadyImported = isInspectedVolume && !!inspection?.duplicate;
              return (
                <button
                  key={v.path}
                  onClick={() => inspectPath(v.path)}
                  disabled={inspectBusy}
                  className="ui-row w-full flex items-center justify-between gap-3 text-left px-3"
                >
                  <span className="ui-body truncate" style={{ color: "var(--text-1)" }}>{v.name}</span>
                  <span
                    className="ui-caption shrink-0"
                    style={{ color: alreadyImported || v.hasImagesDir ? "var(--highlight)" : "var(--text-4)" }}
                  >
                    {alreadyImported ? "✓ imported" : v.hasImagesDir ? "DICOM" : "folder"}
                  </span>
                </button>
              );
            })}
            <div className="flex gap-2">
              <input
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder="/Volumes/Disc Name"
                className="ui-field min-w-0 flex-1"
              />
              <button
                onClick={() => inspectPath(customPath)}
                disabled={inspectBusy || !customPath.trim()}
                className="ui-control"
              >
                inspect
              </button>
            </div>
          </div>
        </details>
      </div>
      {inspection && (
        <div className="mt-3 pt-3 space-y-3" style={{ borderTop: "1px solid var(--stroke)" }}>
          <div className="flex gap-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="ui-field min-w-0 flex-1"
            />
            <button
              onClick={() => startImport(false)}
              disabled={job?.status === "queued" || job?.status === "running" || !!inspection.duplicate}
              className="ui-control"
            >
              {inspection.duplicate ? "imported" : "import"}
            </button>
          </div>
          {inspection.duplicate && (
            <div
              className="ui-surface-raised px-3 py-2 ui-caption flex items-center gap-2"
              style={{ background: "rgba(223,232,217,0.10)", color: "var(--highlight)" }}
            >
              <span>✓</span>
              <span>Already in dataset as {inspection.duplicate.label}</span>
            </div>
          )}
          <div className="ui-caption">
            {inspection.study_date ?? "date unknown"} · {inspection.series.length} series ·{" "}
            {inspection.series.reduce((sum, s) => sum + s.n_slices, 0)} images
          </div>
          <div className="max-h-24 overflow-auto space-y-1 pr-1">
            {inspection.series.map((s) => (
              <div key={s.series_id} className="ui-caption flex justify-between gap-2">
                <span className="truncate">
                  {s.modality} · {s.series_description || s.series_id}
                </span>
                <span className="shrink-0">{s.n_slices}</span>
              </div>
            ))}
          </div>
          {inspection.duplicate && (
            <button
              onClick={() => startImport(true)}
              className="ui-control"
              style={{ border: "1px solid var(--warn)", color: "var(--warn)" }}
            >
              re-import anyway
            </button>
          )}
        </div>
      )}
      {job && (
        <div className="ui-caption mt-3">
          {job.studyLabel}: {job.status}
        </div>
      )}
      {message && (
        <div
          className="ui-caption mt-3"
          style={{
            color:
              message.includes("failed") || message.includes("Could not")
                ? "rgb(252,165,165)"
                : "var(--text-3)",
          }}
        >
          {message}
        </div>
      )}
    </div>
  );
}

function ImportCdModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  return (
    <div
      aria-hidden={!open}
      className={`${open ? "fixed" : "hidden"} ui-backdrop inset-0 z-50 items-start justify-center px-4 py-16 ${open ? "flex" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ui-modal-panel w-full max-w-[460px] overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between ui-divider" style={{ borderBottomWidth: 1 }}>
          <div className="ui-title">
            Import CD
          </div>
          <button
            onClick={onClose}
            className="ui-control"
          >
            close
          </button>
        </div>
        <div className="p-5">
          <ImportCdPanel onImported={onImported} framed={false} />
        </div>
      </div>
    </div>
  );
}

function HeaderSelect({
  value,
  onChange,
  children,
  disabled,
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      title={title}
      className="ui-control ui-control-select min-w-[160px] max-w-[260px] flex-1"
    >
      {children}
    </select>
  );
}

function studyDateLabel(study: StudyMeta): string {
  return study.study_date ?? study.label;
}

function studyMenuLabel(study: StudyMeta): string {
  return study.study_date ? `${study.study_date} · ${study.label}` : study.label;
}

function DateChecklistDropdown({
  studies,
  selectedStudyIds,
  onChange,
  onRenameStudy,
}: {
  studies: StudyMeta[];
  selectedStudyIds: string[];
  onChange: (studyIds: string[]) => void;
  onRenameStudy: (studyId: string, label: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [editingStudyId, setEditingStudyId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedStudies = studies.filter((s) => selectedStudyIds.includes(s.study_id));
  const label =
    selectedStudies.length === 0
      ? "Date"
      : selectedStudies.length === 1
        ? studyDateLabel(selectedStudies[0])
        : `${selectedStudies.length} dates selected`;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggleStudy = (studyId: string) => {
    const checked = selectedStudyIds.includes(studyId);
    if (checked && selectedStudyIds.length === 1) return;
    const next = checked
      ? selectedStudyIds.filter((id) => id !== studyId)
      : studies.filter((s) => [...selectedStudyIds, studyId].includes(s.study_id)).map((s) => s.study_id);
    onChange(next);
  };

  const beginRename = (study: StudyMeta) => {
    setEditingStudyId(study.study_id);
    setDraftLabel(study.label);
    setRenameError(null);
  };

  const saveRename = async () => {
    if (!editingStudyId) return;
    const nextLabel = draftLabel.trim();
    if (!nextLabel) {
      setRenameError("Name cannot be empty.");
      return;
    }
    setSavingLabel(true);
    setRenameError(null);
    try {
      await onRenameStudy(editingStudyId, nextLabel);
      setEditingStudyId(null);
      setDraftLabel("");
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingLabel(false);
    }
  };

  return (
    <div ref={menuRef} className="relative min-w-[156px] max-w-[280px] flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ui-control w-full justify-between"
        title="Date selector"
      >
        <span className="truncate">{label}</span>
        <span aria-hidden="true" style={{ color: "var(--text-4)" }}>
          {open ? "⌃" : "⌄"}
        </span>
      </button>
      {open && (
        <div
          className="ui-menu absolute left-0 top-full z-40 mt-2 w-[420px] max-w-[calc(100vw-32px)] p-2"
        >
          <div className="space-y-2">
            {studies.map((study) => {
              const editing = editingStudyId === study.study_id;
              return (
                <div
                  key={study.study_id}
                  className="ui-row flex items-center gap-2 px-2.5 ui-body"
                  style={{ color: "var(--text-1)" }}
                >
                  <input
                    type="checkbox"
                    checked={selectedStudyIds.includes(study.study_id)}
                    onChange={() => toggleStudy(study.study_id)}
                    className="h-3.5 w-3.5 accent-[var(--highlight)] shrink-0"
                    aria-label={`Select ${studyMenuLabel(study)}`}
                  />
                  {editing ? (
                    <>
                      <input
                        value={draftLabel}
                        onChange={(e) => setDraftLabel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveRename();
                          if (e.key === "Escape") setEditingStudyId(null);
                        }}
                        className="ui-field min-w-0 flex-1"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => void saveRename()}
                        disabled={savingLabel}
                        className="ui-control shrink-0"
                      >
                        save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingStudyId(null)}
                        disabled={savingLabel}
                        className="ui-control shrink-0"
                      >
                        cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => toggleStudy(study.study_id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="block truncate">{studyMenuLabel(study)}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => beginRename(study)}
                        className="ui-control shrink-0"
                        title={`Rename ${study.label}`}
                      >
                        rename
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {renameError && (
            <div className="ui-caption mt-2" style={{ color: "rgb(252,165,165)" }}>
              {renameError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const [studies, setStudies] = useState<StudyMeta[]>([]);
  const [series, setSeries] = useState<SeriesMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeStudyId, setActiveStudyId] = useState<string | null>(null);
  const [selectedStudyIds, setSelectedStudyIds] = useState<string[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [provider, setProvider] = useState<Provider>("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keysStatus, setKeysStatus] = useState<KeysStatus | null>(null);
  const [scanPhase, setScanPhase] = useState<ScanPhase>("idle");
  const [scanReport, setScanReport] = useState<ScanReportMeta | null>(null);
  const [timelineJob, setTimelineJob] = useState<ProgressionCompareJob | null>(null);
  const [timelineReport, setTimelineReport] = useState<ProgressionCompareResult | null>(null);
  const [timelineHistory, setTimelineHistory] = useState<ProgressionCompareHistoryItem[]>([]);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [mobileView, setMobileView] = useState<"viewer" | "chat">("viewer");
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === "desktop";

  const captureRef = useRef<CaptureFn | null>(null);
  const gotoRef = useRef<((index: number) => void) | null>(null);
  const [captureReady, setCaptureReady] = useState(false);
  const requestCounterRef = useRef(0);
  const activeRequestSeriesRef = useRef<string | null>(null);
  const activeIdRef = useRef<string | null>(null);

  // Keep activeIdRef synced with activeId — done in an effect (not during render)
  // so eslint react-hooks/refs is happy.
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Stable capture-registration object so Viewer's effect doesn't re-fire each render
  const onCaptureReady = useCallback((ready: boolean) => setCaptureReady(ready), []);
  const captureRegistration = useMemo(
    () => ({ ref: captureRef, onReady: onCaptureReady, gotoRef }),
    [onCaptureReady],
  );

  // Disambiguate tab labels when two series would otherwise look identical
  const tabLabels = useMemo(() => {
    return disambiguateShorts(
      series.map((s) => ({ key: s.series_key, n_slices: s.n_slices, short: friendlyName(s).short })),
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
  const onViewerSliceChange = useCallback(() => {}, []);

  const refreshKeys = useCallback(() => {
    fetch("/api/keys/status")
      .then((r) => r.json())
      .then((d) => setKeysStatus(d.keys))
      .catch(() => setKeysStatus(null));
  }, []);

  const refreshStudy = useCallback(async () => {
    const res = await fetch("/api/study");
    if (!res.ok) throw new Error(`study load failed: ${res.status}`);
    const d = await res.json();
    const ss = (d.series ?? []) as SeriesMeta[];
    const loadedStudies = (d.studies ?? []) as StudyMeta[];
    setStudies(loadedStudies);
    setSeries(ss);
    const defaultSelection = loadedStudies.slice(-2).map((s) => s.study_id);
    setSelectedStudyIds((prev) => {
      const valid = prev.filter((id) => loadedStudies.some((s) => s.study_id === id));
      return valid.length > 0 ? valid : defaultSelection;
    });
    const defaultStudy =
      loadedStudies.find((s) => s.study_id === defaultSelection.at(-1)) ??
      loadedStudies[loadedStudies.length - 1] ??
      null;
    const candidates = defaultStudy ? ss.filter((s) => s.study_id === defaultStudy.study_id) : ss;
    const pet = candidates.find((s) => s.modality === "PT") ?? candidates[0] ?? ss[0];
    if (pet) {
      setActiveStudyId(pet.study_id);
      setActiveId(pet.series_key);
    }
  }, []);

  useEffect(() => {
    refreshStudy().catch((e) =>
      setError(`Could not load study: ${e}. Start the server with: cd server && npm run dev`),
    );
    refreshKeys();
  }, [refreshKeys, refreshStudy]);

  // Auto-pick a configured provider once keys load, if the current pick isn't configured.
  // The setProvider in this effect IS intentional cascade (re-evaluates after key change);
  // suppressing the lint rule because the alternative (derived state) doesn't apply when
  // the user can manually override `provider`.
  useEffect(() => {
    if (!keysStatus) return;
    const currentKeyName = (Object.entries(KEY_TO_PROVIDER).find(([, p]) => p === provider)?.[0]) as ProviderKeyName | undefined;
    if (!currentKeyName || keysStatus[currentKeyName]?.configured) return;
    const firstConfigured = (Object.entries(keysStatus).find(([, v]) => v.configured)?.[0]) as ProviderKeyName | undefined;
    if (firstConfigured) setProvider(KEY_TO_PROVIDER[firstConfigured]);
  }, [keysStatus, provider]);

  const anyKeyConfigured = !!keysStatus && Object.values(keysStatus).some((s) => s.configured);

  const active = series.find((s) => s.series_key === activeId) ?? null;
  const activeGroupKey = useMemo(() => (active ? matchGroupKeyForSeries(active) : ""), [active]);
  const visibleSeries = useMemo(
    () => (activeStudyId ? series.filter((s) => s.study_id === activeStudyId) : series),
    [activeStudyId, series],
  );
  const pickSeriesForStudy = useCallback(
    (studyId: string | null, target: SeriesMeta | null): SeriesMeta | null => {
      if (!studyId) return null;
      const candidates = series.filter((s) => s.study_id === studyId);
      if (candidates.length === 0) return null;
      if (!target) return candidates.find((s) => s.modality === "PT") ?? candidates[0];
      const matching = candidates.filter(
        (s) =>
          s.modality === target.modality &&
          s.series_description === target.series_description,
      );
      if (matching.length === 0) {
        return candidates.find((s) => s.modality === target.modality) ?? candidates[0];
      }
      return matching
        .slice()
        .sort((a, b) => Math.abs(a.n_slices - target.n_slices) - Math.abs(b.n_slices - target.n_slices))[0];
    },
    [series],
  );
  const goToEvidence = useCallback((seriesKey: string, sliceIndex: number) => {
    const target = series.find((s) => s.series_key === seriesKey);
    if (target) {
      setActiveStudyId(target.study_id);
      setActiveId(target.series_key);
    }
    window.setTimeout(() => gotoRef.current?.(sliceIndex), 50);
  }, [series]);
  const selectedSeries = useMemo(() => {
    if (!active) return [];
    return studies
      .filter((study) => selectedStudyIds.includes(study.study_id))
      .map((study) => pickSeriesForStudy(study.study_id, active))
      .filter(Boolean) as SeriesMeta[];
  }, [active, pickSeriesForStudy, selectedStudyIds, studies]);
  const selectedReportStudyIds = useMemo(() => {
    if (!active) return [];
    return Array.from(
      new Set(
        selectedSeries
          .filter((s) => matchGroupKeyForSeries(s) === activeGroupKey)
          .map((s) => s.study_id),
      ),
    );
  }, [active, activeGroupKey, selectedSeries]);
  const canCreateTimelineReport = selectedReportStudyIds.length >= 2;
  const matchingSavedTimelineReport = useMemo(() => {
    if (!activeGroupKey || selectedReportStudyIds.length < 2) return null;
    return (
      timelineHistory.find(
        (item) =>
          item.seriesGroup.groupKey === activeGroupKey &&
          sameStudySelection(
            item.studies.map((study) => study.studyId),
            selectedReportStudyIds,
          ),
      ) ?? null
    );
  }, [activeGroupKey, selectedReportStudyIds, timelineHistory]);
  const refreshTimelineHistory = useCallback(async (groupKey = activeGroupKey) => {
    if (!groupKey) {
      setTimelineHistory([]);
      return;
    }
    const res = await fetch(`/api/progression/compare/history?groupKey=${encodeURIComponent(groupKey)}`);
    if (!res.ok) throw new Error(`report history load failed: ${res.status}`);
    const body = (await res.json()) as { reports?: ProgressionCompareHistoryItem[] };
    setTimelineHistory(body.reports ?? []);
  }, [activeGroupKey]);
  useEffect(() => {
    refreshTimelineHistory().catch((e) => {
      console.warn("[timeline history]", e);
      setTimelineHistory([]);
    });
  }, [refreshTimelineHistory]);
  const referenceSeries = useMemo(
    () => selectedSeries.filter((s) => s.series_key !== active?.series_key).reverse(),
    [active?.series_key, selectedSeries],
  );
  const activeComparisonSeries = referenceSeries[0] ?? null;
  const extraTimelineSeries = referenceSeries.slice(1, 3);

  const onUserAnnotation = (a: Omit<Annotation, "id" | "source">) => {
    setAnnotations((prev) => [...prev, { ...a, id: crypto.randomUUID(), source: "user" }]);
  };

  const onAsk = async (question: string) => {
    if (!active || !captureRef.current) return;
    if (busy) return; // hard guard against concurrent asks

    const requestId = ++requestCounterRef.current;
    const requestSeriesId = active.series_key;
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
          studyId: cap.studyId,
          studyLabel: active.study_label,
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
    setScanReport(null);
    setScanPhase("survey");
    const requestId = ++requestCounterRef.current;
    const requestSeriesId = active.series_key;
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
    const saveScanReport = async (payload: ScanReportPayload) => {
      try {
        const reportRes = await fetch("/api/scan/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            studyId: seriesAtStart.study_id,
            seriesId: seriesAtStart.series_id,
            ...payload,
          }),
        });
        if (!reportRes.ok) {
          const body = await reportRes.json().catch(() => ({ error: "report_write_failed" }));
          throw new Error(body.error ?? reportRes.statusText);
        }
        const report = (await reportRes.json()) as ScanReportMeta;
        if (!isStale()) setScanReport(report);
      } catch (e) {
        if (!isStale()) {
          const message = e instanceof Error ? e.message : String(e);
          setError(`Scan completed, but the Markdown note was not saved: ${message}`);
        }
      }
    };

    try {
      // ---- Phase 1: Survey ----
      const surveyRes = await fetch("/api/scan/survey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, studyId: seriesAtStart.study_id, seriesId: seriesAtStart.series_id }),
      });
      if (isStale()) return;
      if (!surveyRes.ok) {
        const body = await surveyRes.json().catch(() => ({ error: "survey_failed" }));
        throw new Error(`survey: ${body.error ?? surveyRes.statusText}`);
      }
      const survey = (await surveyRes.json()) as {
        text: string;
        rois: ServerROI[];
        sampledIndices?: number[];
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
        await saveScanReport({ survey });
        if (isStale()) return;
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
          studyId: seriesAtStart.study_id,
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
        inspectedIndices?: number[];
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
        await saveScanReport({ survey, zoom });
        if (isStale()) return;
        setScanPhase("done");
        return;
      }
      setScanPhase("deep");
      const deepRes = await fetch("/api/scan/deep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          studyId: seriesAtStart.study_id,
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
        inspectedIndices?: number[];
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
      await saveScanReport({ survey, zoom, deep });
      if (isStale()) return;
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

  const loadTimelineReport = useCallback(async (resultId: string) => {
    setError(null);
    const resultRes = await fetch(`/api/progression/compare/results/${encodeURIComponent(resultId)}`);
    const result = (await resultRes.json().catch(() => ({}))) as ProgressionCompareResult;
    if (!resultRes.ok) throw new Error("timeline_report_result_failed");
    setTimelineJob(null);
    setTimelineReport(result);
    setHistory((h) => {
      if (h.some((turn) => turn.progressionCompare?.resultId === result.resultId)) return h;
      return [
        ...h,
        {
          role: "assistant",
          content: result.text,
          provider: result.provider,
          progressionCompare: result,
        },
      ];
    });
  }, []);

  const exportTimelineReport = useCallback(async (resultId: string) => {
    setError(null);
    const markdownRes = await fetch(`/api/progression/compare/results/${encodeURIComponent(resultId)}/markdown`);
    if (!markdownRes.ok) throw new Error("timeline_report_export_failed");
    const markdown = await markdownRes.text();
    const historyItem = timelineHistory.find((item) => item.resultId === resultId);
    const date = (historyItem?.createdAt ?? new Date().toISOString()).slice(0, 10);
    const scanType = historyItem?.seriesGroup.label ?? "timeline-report";
    downloadTextFile(
      `${safeDownloadName(`lumen-${scanType}-${date}`)}.md`,
      markdown,
      "text/markdown;charset=utf-8",
    );
  }, [timelineHistory]);

  const deleteTimelineReport = useCallback(async (resultId: string) => {
    const item = timelineHistory.find((historyItem) => historyItem.resultId === resultId);
    const label = item?.createdAt ? new Date(item.createdAt).toLocaleString() : "this saved report";
    const confirmed = window.confirm(
      `Delete ${label}?\n\nThis removes the saved timeline report and Markdown file. It does not delete any scan images.`,
    );
    if (!confirmed) return;
    setError(null);
    const deleteRes = await fetch(`/api/progression/compare/results/${encodeURIComponent(resultId)}`, {
      method: "DELETE",
    });
    const body = (await deleteRes.json().catch(() => ({}))) as { reports?: ProgressionCompareHistoryItem[]; error?: string };
    if (!deleteRes.ok) throw new Error(body.error ?? "report_delete_failed");
    setTimelineHistory(body.reports ?? []);
    if (timelineReport?.resultId === resultId) {
      setTimelineReport(null);
      setTimelineJob(null);
    }
    setHistory((h) => h.filter((turn) => turn.progressionCompare?.resultId !== resultId));
  }, [timelineHistory, timelineReport?.resultId]);

  const onCreateTimelineReport = async () => {
    if (!active || busy) return;
    if (selectedReportStudyIds.length < 2) {
      setError("Select at least two dates that have this scan type before creating a report.");
      return;
    }
    if (matchingSavedTimelineReport) {
      try {
        await loadTimelineReport(matchingSavedTimelineReport.resultId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    const requestId = ++requestCounterRef.current;
    const requestSeriesId = active.series_key;
    const groupKey = activeGroupKey;
    const seriesLabel = friendlyName(active).short;
    const dateCount = selectedReportStudyIds.length;
    const isStale = () =>
      requestId !== requestCounterRef.current || activeIdRef.current !== requestSeriesId;

    setBusy(true);
    setError(null);
    setTimelineJob(null);
    setTimelineReport(null);
    setHistory((h) => [
      ...h,
      {
        role: "user",
        content: `Create timeline report for ${seriesLabel} across ${dateCount} selected dates.`,
      },
    ]);

    try {
      const startRes = await fetch("/api/progression/compare/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          groupKey,
          studyIds: selectedReportStudyIds,
        }),
      });
      if (isStale()) return;
      const startBody = await startRes.json().catch(() => ({}));
      if (!startRes.ok) {
        throw new Error(startBody.error ?? "timeline_report_start_failed");
      }
      const jobId = String(startBody.jobId ?? "");
      if (!jobId) throw new Error("timeline_report_job_missing");
      setTimelineJob({
        jobId,
        status: "queued",
        provider,
        groupKey,
        studyIds: selectedReportStudyIds,
        progress: {
          phase: "queued",
          percent: 0,
          detail: "Queued",
          totalStudies: selectedReportStudyIds.length,
          completedStudies: 0,
        },
      });

      while (true) {
        await sleep(1500);
        if (isStale()) return;
        const jobRes = await fetch(`/api/progression/compare/jobs/${encodeURIComponent(jobId)}`);
        const nextJob = (await jobRes.json().catch(() => ({}))) as ProgressionCompareJob;
        if (!jobRes.ok) throw new Error(nextJob.error ?? "timeline_report_job_failed");
        if (isStale()) return;
        setTimelineJob(nextJob);
        if (nextJob.status === "failed") {
          throw new Error(nextJob.error ?? "timeline_report_failed");
        }
        if (nextJob.status === "completed" && nextJob.resultId) {
          const resultRes = await fetch(`/api/progression/compare/results/${encodeURIComponent(nextJob.resultId)}`);
          const result = (await resultRes.json().catch(() => ({}))) as ProgressionCompareResult;
          if (!resultRes.ok) throw new Error("timeline_report_result_failed");
          if (isStale()) return;
          setTimelineReport(result);
          await refreshTimelineHistory(groupKey).catch((historyError) => {
            console.warn("[timeline history]", historyError);
          });
          setHistory((h) => [
            ...h,
            {
              role: "assistant",
              content: result.text,
              provider: result.provider,
              progressionCompare: result,
            },
          ]);
          break;
        }
      }
    } catch (e) {
      if (!isStale()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!isStale()) setBusy(false);
    }
  };

  const switchSeries = (seriesKey: string) => {
    const next = series.find((s) => s.series_key === seriesKey);
    setActiveId(seriesKey);
    if (next) setActiveStudyId(next.study_id);
    setAnnotations([]);
    setHistory([]);
    setError(null);
    setScanPhase("idle");
    setScanReport(null);
    setTimelineJob(null);
    setTimelineReport(null);
    setBusy(false);
    requestCounterRef.current++; // invalidate any in-flight request
  };

  const switchStudyDates = (studyIds: string[]) => {
    if (studyIds.length === 0) return;
    const orderedStudyIds = studies
      .filter((study) => studyIds.includes(study.study_id))
      .map((study) => study.study_id);
    const latestStudyId = orderedStudyIds.at(-1) ?? studyIds.at(-1) ?? null;
    const next = pickSeriesForStudy(latestStudyId, active);
    setSelectedStudyIds(orderedStudyIds);
    if (next) {
      setActiveStudyId(next.study_id);
      setActiveId(next.series_key);
    }
    setAnnotations([]);
    setHistory([]);
    setError(null);
    setScanPhase("idle");
    setScanReport(null);
    setTimelineJob(null);
    setTimelineReport(null);
    setBusy(false);
    requestCounterRef.current++;
  };

  const renameStudyLabel = async (studyId: string, label: string) => {
    const res = await fetch(`/api/studies/${encodeURIComponent(studyId)}/label`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "rename_failed" }));
      throw new Error(body.error ?? "Could not rename scan.");
    }
    await refreshStudy();
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

  if (error && series.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-lg ui-body">
          <div className="ui-alert ui-alert-error mb-2 p-3 rounded-[var(--radius-card)]">Could not load the scan.</div>
          <pre className="ui-surface p-3 whitespace-pre-wrap">
            {error}
          </pre>
        </div>
      </div>
    );
  }

  if (series.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-6" style={{ background: "var(--bg-base)" }}>
        <div className="w-full max-w-xl space-y-4">
          <div>
            <div className="ui-title">
              Lumen
            </div>
            <div className="ui-caption mt-1">
              No imported studies found.
            </div>
          </div>
          <ImportCdPanel onImported={refreshStudy} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--bg-base)" }}>
	      <header
	        className={`px-5 py-2 min-h-[56px] flex items-center gap-3 ${isDesktop ? "justify-between" : "flex-wrap"}`}
	        style={{ background: "var(--bg-base)", borderBottom: "1px solid var(--stroke)" }}
	      >
	        <div className={`flex items-center gap-3 min-w-0 ${isDesktop ? "" : "w-full overflow-x-auto pb-1"}`}>
          <div className="ui-brand shrink-0">
            Lumen
          </div>
          {studies.length > 0 && (
            <DateChecklistDropdown
              studies={studies}
              selectedStudyIds={selectedStudyIds}
              onChange={switchStudyDates}
              onRenameStudy={renameStudyLabel}
            />
          )}
          {activeId && (
            <HeaderSelect value={activeId} onChange={switchSeries} title="Scan type">
              {visibleSeries.map((s) => {
                const fn = friendlyName(s);
                return (
                  <option key={s.series_key} value={s.series_key}>
                    {tabLabels.get(s.series_key) ?? fn.short}
                  </option>
                );
              })}
            </HeaderSelect>
          )}
        </div>
	        <div className={`flex items-center gap-1.5 shrink-0 ${isDesktop ? "" : "w-full overflow-x-auto pb-1"}`}>
          {!isDesktop && (
            <div className="ui-segmented">
              <button
                onClick={() => setMobileView("viewer")}
                className={`ui-segmented-button ${mobileView === "viewer" ? "ui-segmented-button-active" : ""}`}
              >
                Scan
              </button>
              <button
                onClick={() => setMobileView("chat")}
                className={`ui-segmented-button ${mobileView === "chat" ? "ui-segmented-button-active" : ""}`}
              >
                Chat
              </button>
            </div>
          )}
          <HeaderPill onClick={() => setImportOpen(true)} title="Import a CD or scan folder">
            import CD
          </HeaderPill>
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
          {isDesktop && (
            <SidePanelToggle
              collapsed={chatCollapsed}
              onClick={() => setChatCollapsed((v) => !v)}
            />
          )}
        </div>
      </header>
      {keysStatus && !anyKeyConfigured && (
        <button
          onClick={() => setSettingsOpen(true)}
          className="ui-alert px-4 py-2 text-left flex items-center gap-2"
        >
          <span>▲</span>
	          <span>
	            No AI keys configured yet.{" "}
	            <span style={{ color: "var(--text-1)" }} className="underline">Add a key</span> to start
	            asking questions (you only need one — Claude, GPT-5.5, or Gemini).
	          </span>
        </button>
      )}
      {error && (
        <div
          className="ui-alert ui-alert-error px-4 py-2 flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ui-control"
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
                comparisonSeries={activeComparisonSeries}
                timelineSeries={extraTimelineSeries}
                annotations={annotations}
                onUserAnnotation={onUserAnnotation}
                onSliceChange={onViewerSliceChange}
                capture={captureRegistration}
                flaggedSlices={flaggedSlices}
              />
            }
            right={
              <Chat
                history={history}
                busy={busy}
                provider={provider}
                setProvider={setProvider}
                onAsk={onAsk}
                askDisabled={!captureReady}
	                onScan={onScan}
	                onCreateReport={onCreateTimelineReport}
	                createReportDisabled={!canCreateTimelineReport}
	                reportJob={timelineJob}
	                timelineReport={timelineReport}
                  reportHistory={timelineHistory}
                  matchingSavedReportId={matchingSavedTimelineReport?.resultId ?? null}
                  onLoadReport={(resultId) => {
                    loadTimelineReport(resultId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                  onExportReport={(resultId) => {
                    exportTimelineReport(resultId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                  onDeleteReport={(resultId) => {
                    deleteTimelineReport(resultId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
                  }}
	                selectedDateCount={selectedReportStudyIds.length}
	                scanTargetLabel={friendlyName(active).short}
	                onJumpToSlice={goToSlice}
	                onJumpToEvidence={goToEvidence}
	                scanPhase={scanPhase}
                scanReport={scanReport}
              />
            }
          />
        )}
        {active && !isDesktop && (
          <div className="h-full w-full overflow-hidden">
            {mobileView === "viewer" ? (
              <Viewer
                series={active}
                comparisonSeries={activeComparisonSeries}
                timelineSeries={extraTimelineSeries}
                annotations={annotations}
                onUserAnnotation={onUserAnnotation}
                onSliceChange={onViewerSliceChange}
                capture={captureRegistration}
                flaggedSlices={flaggedSlices}
              />
            ) : (
              <Chat
                history={history}
                busy={busy}
                provider={provider}
                setProvider={setProvider}
                onAsk={onAsk}
                askDisabled={!captureReady}
	                onScan={onScan}
	                onCreateReport={onCreateTimelineReport}
	                createReportDisabled={!canCreateTimelineReport}
	                reportJob={timelineJob}
	                timelineReport={timelineReport}
                  reportHistory={timelineHistory}
                  matchingSavedReportId={matchingSavedTimelineReport?.resultId ?? null}
                  onLoadReport={(resultId) => {
                    loadTimelineReport(resultId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                  onExportReport={(resultId) => {
                    exportTimelineReport(resultId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                  onDeleteReport={(resultId) => {
                    deleteTimelineReport(resultId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
                  }}
	                selectedDateCount={selectedReportStudyIds.length}
	                scanTargetLabel={friendlyName(active).short}
	                onJumpToSlice={goToSlice}
	                onJumpToEvidence={goToEvidence}
	                scanPhase={scanPhase}
                scanReport={scanReport}
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
      <ImportCdModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={refreshStudy}
      />
    </div>
  );
}
