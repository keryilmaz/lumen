export type Provider = "claude" | "gpt5" | "gemini";

export type SeriesMeta = {
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
};

/** Returned by Viewer.capture() — carries enough context that App can validate
 *  the response actually matches the slice the user was looking at when they asked,
 *  and can denormalize AI annotations against the same image dimensions used when
 *  drawing user annotations (avoiding the coord-drift Codex flagged). */
export type Capture = {
  slicePng: string;
  roiPng?: string;
  sliceIndex: number;
  seriesId: string;
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
