export type Provider = "claude" | "gpt5" | "gemini";

export type SeriesMeta = {
  study_id: string;
  study_label: string;
  study_date?: string;
  series_key: string;
  series_id: string;
  modality: string;
  series_description: string;
  n_slices: number;
  rows: number;
  columns: number;
  manufacturer: string;
  model: string;
  slices: { index: number; filename: string; z_position: number }[];
};

export type StudyMeta = {
  study_id: string;
  label: string;
  study_date?: string;
  source?: string;
  source_volume?: string;
  imported_at?: string;
  study_signature?: string;
  series: {
    series_id: string;
    modality: string;
    series_description: string;
    n_slices: number;
  }[];
};

export type SeriesMatchGroup = {
  group_key: string;
  modality: string;
  series_description: string;
  label: string;
  studies: {
    study_id: string;
    study_label: string;
    study_date?: string;
    series_key: string;
    series_id: string;
    modality: string;
    series_description: string;
    n_slices: number;
  }[];
};

export type ImportVolume = {
  name: string;
  path: string;
  hasImagesDir: boolean;
};

export type ImportInspection = {
  path: string;
  volume_name: string;
  study_date?: string;
  suggested_label: string;
  suggested_id: string;
  signature: string;
  series: {
    series_id: string;
    n_slices: number;
    modality: string;
    series_description: string;
    rows?: number;
    columns?: number;
    frames_per_file?: number;
  }[];
  duplicate?: {
    study_id: string;
    label: string;
    study_date?: string;
  } | null;
};

export type Annotation = {
  id: string;
  source: "user" | "ai";
  provider?: Provider;
  sliceIndex: number;
  /** All in image-pixel coords. */
  cx: number;
  cy: number;
  r: number;
  label?: string;
  confidence?: number;
};

/** Educational, non-diagnostic finding from the AI scan. The user explicitly asked for
 *  this shape: observation + possibilities + healthy comparison + doctor questions. */
export type Finding = {
  id: string;
  sliceIndex: number;
  /** Image-pixel coords (denormalized at receive time so Viewer renders directly). */
  cx: number;
  cy: number;
  r: number;
  region: string;
  observation: string;
  possibleMeanings: string[];
  healthyComparison: string;
  questionsForOncologist: string[];
  confidence: number;
  severity: "notable" | "worth-asking" | "clearly-physiologic";
  provider: Provider;
};

export type ScanPhase = "idle" | "survey" | "zoom" | "deep" | "done";

export type ScanReportMeta = {
  reportId: string;
  reportPath: string;
  latestPath: string;
  createdAt: string;
};

export type ProgressionCompareProgress = {
  phase: "queued" | "scanning" | "matching" | "summarizing" | "completed" | "failed";
  percent: number;
  detail?: string;
  currentStudy?: string;
  completedStudies?: number;
  totalStudies?: number;
};

export type ProgressionCompareJob = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  provider: Provider;
  groupKey: string;
  studyIds: string[];
  resultId?: string;
  error?: string;
  progress: ProgressionCompareProgress;
};

export type ComparisonFindingStatus =
  | "seen_across_dates"
  | "later_date_only"
  | "earlier_date_only"
  | "changed_appearance_or_extent"
  | "uncertain_match";

export type ComparisonEvidence = {
  studyId: string;
  studyLabel: string;
  studyDate?: string;
  seriesId: string;
  seriesKey: string;
  sliceIndex: number;
  relativeSlice: number;
  xNorm: number;
  yNorm: number;
  radiusNorm: number;
  region: string;
  observation: string;
  possibleMeanings: string[];
  healthyComparison: string;
  questionsForOncologist: string[];
  confidence: number;
  severity: Finding["severity"];
};

export type ComparisonFindingGroup = {
  groupId: string;
  status: ComparisonFindingStatus;
  title: string;
  visibleChangeSummary: string;
  confidence: number;
  limitations: string[];
  oncologistQuestions: string[];
  evidence: ComparisonEvidence[];
};

export type ProgressionCompareResult = {
  resultId: string;
  schemaVersion: string;
  createdAt: string;
  provider: Provider;
  seriesGroup: {
    groupKey: string;
    label: string;
    modality: string;
    seriesDescription: string;
  };
  studies: {
    studyId: string;
    studyLabel: string;
    studyDate?: string;
    seriesId: string;
    seriesKey: string;
    totalSlices: number;
    findingCount: number;
    cacheStatus: "hit" | "miss";
  }[];
  groups: ComparisonFindingGroup[];
  limitations: string[];
  text: string;
  disclaimer: string;
  reportPath?: string;
  latestPath?: string;
};

export type ProgressionCompareHistoryItem = {
  resultId: string;
  createdAt: string;
  provider: Provider;
  seriesGroup: ProgressionCompareResult["seriesGroup"];
  studies: ProgressionCompareResult["studies"];
  groupCount: number;
  reportPath?: string;
  latestPath?: string;
  textPreview: string;
};

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  provider?: Provider;
  annotations?: Annotation[];
  sliceIndex?: number;
  /** Legacy single-pass scan summary: chips list the slices the AI flagged. */
  scan?: {
    sampledIndices: number[];
    flagged: { sliceIndex: number; label: string; confidence: number }[];
  };
  /** Three-pass scan: phase summary + structured findings to render as cards. */
  scanPhase?: {
    phase: "survey" | "zoom" | "deep";
    summary: string;
    findings?: Finding[];
    roiCount?: number;
  };
  /** Whole-scan timeline compare: scan-level findings matched across dates. */
  progressionCompare?: ProgressionCompareResult;
};

/** Returned by Viewer.capture() — carries enough context that App can validate
 *  the response actually matches the slice the user was looking at when they asked,
 *  and can denormalize AI annotations against the same image dimensions used when
 *  drawing user annotations (avoiding the coord-drift Codex flagged). */
export type Capture = {
  slicePng: string;
  comparisonSlicePng?: string;
  roiPng?: string;
  sliceIndex: number;
  comparisonSliceIndex?: number;
  seriesId: string;
  studyId: string;
  comparisonSeriesId?: string;
  comparisonStudyId?: string;
  /** Pixel dimensions of the actual loaded PNG. May differ from SeriesMeta.columns/rows
   *  if extraction resampled, so this is the source of truth for normalization. */
  imageWidth: number;
  imageHeight: number;
  /** URL the image was loaded from. Used for diagnostics; gating happens inside Viewer. */
  sliceUrl: string;
};

export type CaptureFn = () => Promise<Capture>;

export type CaptureRegistration = {
  ref: React.MutableRefObject<CaptureFn | null>;
  /** Called when capture becomes available (image loaded) or null (between loads). */
  onReady: (ready: boolean) => void;
  /** Imperative slot the Viewer fills with a "jump to slice index" function so the
   *  parent can navigate the viewer (e.g., from a clickable AI annotation chip). */
  gotoRef: React.MutableRefObject<((index: number) => void) | null>;
};
