/**
 * Local Express server for Lumen. Loopback-only.
 * Codex review must-fixes applied in this revision:
 *  - Strict seriesId regex shared by /api/study and /api/ask, blocks path traversal
 *    via the series_id path-join.
 *  - Custom /data handler with realpath check; rejects symlink escapes
 *    out of DATA_DIR.
 *  - JSON-parse / body-too-large error middleware: malformed bodies return
 *    typed JSON errors, not Express's HTML stack page.
 *  - Tightened Zod (.strict(), max lengths, history cap, PNG magic-byte gate).
 *  - 8MB body limit (down from 20MB).
 *  - Sanitized error responses — never echoes String(err).
 *  - Trimmed /api/health (no DATA_DIR path leaked).
 */

import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { z } from "zod";
import { COMPARE_PROVIDERS, PROGRESSION_PROVIDERS, PROVIDERS, type Provider } from "./providers.js";
import { SAFETY_DISCLAIMER } from "./safety.js";
import {
  envPath,
  looksLikeValidKey,
  PROVIDER_KEYS,
  readStatus,
  writeKeys,
  type ProviderKey,
} from "./keys.js";
import {
  loadSlicesFromDisk,
  runSurvey,
  runZoom,
  runDeep,
  sampleIndices,
  type ROI,
  type Finding as ScanFinding,
} from "./scan.js";

// Load .env from project root (one level up from server/). Override so that
// running `npm run dev` from server/ still picks up the canonical root .env.
dotenv.config({ path: envPath(), override: true });

const PORT = Number(process.env.PORT ?? 5174);
const CANONICAL_DATA_DIR = path.join(os.homedir(), "Desktop", "scan-companion", "data");
const PROJECT_ROOT = path.resolve(process.cwd(), "..");
const PYTHON_BIN = existsSync(path.join(PROJECT_ROOT, ".venv", "bin", "python"))
  ? path.join(PROJECT_ROOT, ".venv", "bin", "python")
  : "python3";
const INSPECT_SCRIPT = path.join(PROJECT_ROOT, "tools", "python", "inspect_disc.py");
const EXTRACT_SCRIPT = path.join(PROJECT_ROOT, "tools", "python", "extract.py");

// Resolve DATA_DIR. Env override is still supported for dev/test, but the app's
// normal library lives under scan-companion so imported CDs keep accumulating in
// one stable place outside the repo.
const DATA_DIR = (() => {
  const fromEnv = process.env.DATA_DIR;
  if (!fromEnv) return CANONICAL_DATA_DIR;
  if (path.isAbsolute(fromEnv)) return fromEnv;
  return path.resolve(PROJECT_ROOT, fromEnv);
})();

/** Strict series id — shared between routes that join it into a filesystem path. */
const SERIES_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SeriesIdZ = z.string().regex(SERIES_ID_RE, "invalid series_id");
const LEGACY_STUDY_ID = "_legacy";
const StudyIdZ = z.string().regex(SERIES_ID_RE, "invalid study_id").default(LEGACY_STUDY_ID);

function seriesRelPath(studyId: string | undefined, seriesId: string, file = ""): string {
  if (studyId && studyId !== LEGACY_STUDY_ID) {
    return path.join("studies", studyId, seriesId, file);
  }
  return path.join(seriesId, file);
}

/** Validates that path resolves under DATA_DIR (after realpath, so symlinks
 *  cannot escape). Returns the realpath or null if it escapes. */
async function safeResolveUnder(base: string, rel: string): Promise<string | null> {
  const candidate = path.resolve(base, rel);
  try {
    const real = await fs.realpath(candidate);
    const realBase = await fs.realpath(base);
    if (real === realBase) return real;
    if (real.startsWith(realBase + path.sep)) return real;
    return null;
  } catch {
    return null;
  }
}

const app = express();

// 127.0.0.1 only — never expose this to the LAN
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5175",
      "http://127.0.0.1:5175",
    ],
  }),
);
app.use(express.json({ limit: "8mb" }));

// Map JSON-parse errors and body-too-large to typed JSON, not HTML
app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
  if (!err) return next();
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid_json" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "body_too_large" });
  }
  return next(err);
});

// Custom /data handler — realpath-checks every request, deny symlink escape, deny dotfiles.
app.get(/^\/data\/(.+)$/, async (req: Request, res: Response) => {
  const requested = req.params[0];
  if (!requested || requested.includes("..") || requested.startsWith(".") || requested.includes("/.")) {
    return res.status(404).end();
  }
  const real = await safeResolveUnder(DATA_DIR, requested);
  if (!real) return res.status(404).end();
  try {
    const stat = await fs.stat(real);
    if (!stat.isFile()) return res.status(404).end();
    const ext = path.extname(real).toLowerCase();
    const ct =
      ext === ".png"
        ? "image/png"
        : ext === ".json"
          ? "application/json; charset=utf-8"
          : "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    createReadStream(real).pipe(res);
  } catch {
    res.status(404).end();
  }
});

type StudyManifest = {
  study_id?: unknown;
  label?: unknown;
  study_label?: unknown;
  study_date?: unknown;
  source?: unknown;
  source_volume?: unknown;
  imported_at?: unknown;
  study_signature?: unknown;
  series?: { series_id?: unknown; modality?: unknown; series_description?: unknown; n_slices?: unknown }[];
};

type StudySeriesSummary = {
  series_id: string;
  modality: string;
  series_description: string;
  n_slices: number;
};

type LoadedStudy = {
  study: {
    study_id: string;
    label: string;
    study_date?: string;
    source?: string;
    source_volume?: string;
    imported_at?: string;
    study_signature?: string;
    series: StudySeriesSummary[];
  };
  series: unknown[];
};

type SeriesRecord = StudySeriesSummary & {
  study_id: string;
  study_label: string;
  study_date?: string;
  series_key: string;
};

async function readJsonRel<T>(rel: string): Promise<T | null> {
  const real = await safeResolveUnder(DATA_DIR, rel);
  if (!real) return null;
  try {
    return JSON.parse(await fs.readFile(real, "utf8")) as T;
  } catch {
    return null;
  }
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{8}$/.test(trimmed)) return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  return undefined;
}

function normalizeTextForMatch(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function studySignature(studyDate: string | undefined, series: StudySeriesSummary[]): string {
  const parts = series
    .map(
      (s) =>
        `${String(s.modality ?? "").trim().toUpperCase()}::${normalizeTextForMatch(
          s.series_description,
        )}::${Number(s.n_slices ?? 0)}`,
    )
    .sort();
  return `${studyDate ?? ""}|${parts.join("|")}`;
}

function matchGroupKey(seriesMeta: Pick<StudySeriesSummary, "modality" | "series_description">): string {
  return `${String(seriesMeta.modality ?? "").trim().toUpperCase() || "UNKNOWN"}::${normalizeTextForMatch(
    seriesMeta.series_description,
  )}`;
}

function toSeriesRecord(raw: unknown): SeriesRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const studyId = asTrimmedString(m.study_id);
  const studyLabel = asTrimmedString(m.study_label) ?? studyId;
  const seriesId = asTrimmedString(m.series_id);
  if (!studyId || !studyLabel || !seriesId) return null;
  return {
    study_id: studyId,
    study_label: studyLabel,
    study_date: normalizeDate(m.study_date),
    series_key: asTrimmedString(m.series_key) ?? `${studyId}:${seriesId}`,
    series_id: seriesId,
    modality: String(m.modality ?? ""),
    series_description: String(m.series_description ?? ""),
    n_slices: Number(m.n_slices ?? 0),
  };
}

async function loadSeriesMetaForStudy(
  studyId: string,
  label: string,
  studyDate: string | undefined,
  seriesId: string,
): Promise<Record<string, unknown> | null> {
  if (!SERIES_ID_RE.test(seriesId)) return null;
  const meta = await readJsonRel<Record<string, unknown>>(seriesRelPath(studyId, seriesId, "meta.json"));
  if (!meta) return null;
  return {
    ...meta,
    study_id: studyId,
    study_label: label,
    study_date: studyDate ?? "",
    series_id: String(meta.series_id ?? seriesId),
    series_key: `${studyId}:${seriesId}`,
  };
}

async function seriesIdsFromDir(studyId: string): Promise<string[]> {
  const rel = studyId === LEGACY_STUDY_ID ? "" : path.join("studies", studyId);
  const real = await safeResolveUnder(DATA_DIR, rel || ".");
  if (!real) return [];
  try {
    const entries = await fs.readdir(real, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && SERIES_ID_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function loadStudy(studyId: string, label: string, manifest: StudyManifest | null): Promise<LoadedStudy | null> {
  const studyDate = normalizeDate(manifest?.study_date);
  const ids =
    manifest?.series && manifest.series.length > 0
      ? manifest.series.map((s) => String(s.series_id ?? "")).filter((id) => SERIES_ID_RE.test(id))
      : await seriesIdsFromDir(studyId);
  const metas = (await Promise.all(ids.map((id) => loadSeriesMetaForStudy(studyId, label, studyDate, id)))).filter(Boolean) as Record<string, unknown>[];
  if (metas.length === 0) return null;
  const seriesSummary = metas.map((m) => ({
    series_id: String(m.series_id ?? ""),
    modality: String(m.modality ?? ""),
    series_description: String(m.series_description ?? ""),
    n_slices: Number(m.n_slices ?? 0),
  }));
  return {
    study: {
      study_id: studyId,
      label,
      study_date: studyDate,
      source: typeof manifest?.source === "string" ? manifest.source : undefined,
      source_volume: typeof manifest?.source_volume === "string" ? manifest.source_volume : undefined,
      imported_at: typeof manifest?.imported_at === "string" ? manifest.imported_at : undefined,
      study_signature:
        typeof manifest?.study_signature === "string"
          ? manifest.study_signature
          : studySignature(studyDate, seriesSummary),
      series: seriesSummary,
    },
    series: metas,
  };
}

async function loadNestedStudies(): Promise<LoadedStudy[]> {
  const studiesReal = await safeResolveUnder(DATA_DIR, "studies");
  if (!studiesReal) return [];
  try {
    const entries = await fs.readdir(studiesReal, { withFileTypes: true });
    const loaded = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && SERIES_ID_RE.test(e.name) && e.name !== LEGACY_STUDY_ID)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (e) => {
          const manifest = await readJsonRel<StudyManifest>(path.join("studies", e.name, "study.json"));
          const label = asTrimmedString(manifest?.label) ?? asTrimmedString(manifest?.study_label) ?? e.name;
          return loadStudy(e.name, label, manifest);
        }),
    );
    return loaded.filter(Boolean) as LoadedStudy[];
  } catch {
    return [];
  }
}

async function loadLegacyStudy(): Promise<LoadedStudy | null> {
  const manifest = await readJsonRel<StudyManifest>("study.json");
  if (!manifest?.series?.length) return null;
  const label = asTrimmedString(manifest.label) ?? asTrimmedString(manifest.study_label) ?? "Current scan";
  return loadStudy(LEGACY_STUDY_ID, label, manifest);
}

function compareStudiesByDate(a: LoadedStudy, b: LoadedStudy): number {
  const ad = a.study.study_date ?? "9999-12-31";
  const bd = b.study.study_date ?? "9999-12-31";
  if (ad !== bd) return ad.localeCompare(bd);
  const ai = a.study.imported_at ?? "";
  const bi = b.study.imported_at ?? "";
  if (ai !== bi) return ai.localeCompare(bi);
  return a.study.label.localeCompare(b.study.label);
}

async function loadAllStudies(): Promise<LoadedStudy[]> {
  const nested = await loadNestedStudies();
  const loaded = nested.length > 0 ? nested : [];
  if (loaded.length === 0) {
    const legacy = await loadLegacyStudy();
    if (legacy) loaded.push(legacy);
  }
  return loaded.sort(compareStudiesByDate);
}

function buildMatchedSeriesGroups(loaded: LoadedStudy[]) {
  const groups = new Map<
    string,
    {
      group_key: string;
      modality: string;
      series_description: string;
      label: string;
      studies: SeriesRecord[];
    }
  >();
  for (const raw of loaded.flatMap((s) => s.series)) {
    const seriesMeta = toSeriesRecord(raw);
    if (!seriesMeta) continue;
    const key = matchGroupKey(seriesMeta);
    const existing = groups.get(key);
    if (existing) {
      existing.studies.push(seriesMeta);
    } else {
      groups.set(key, {
        group_key: key,
        modality: seriesMeta.modality,
        series_description: seriesMeta.series_description,
        label: `${seriesMeta.modality || "Series"} ${seriesMeta.series_description || seriesMeta.series_id}`.trim(),
        studies: [seriesMeta],
      });
    }
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      studies: g.studies.sort((a, b) => {
        const ad = a.study_date ?? "9999-12-31";
        const bd = b.study_date ?? "9999-12-31";
        if (ad !== bd) return ad.localeCompare(bd);
        return a.study_label.localeCompare(b.study_label);
      }),
    }))
    .sort((a, b) => {
      const byCount = b.studies.length - a.studies.length;
      if (byCount !== 0) return byCount;
      return a.label.localeCompare(b.label);
    });
}

async function migrateLegacyStudyIfNeeded(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const legacyManifest = await readJsonRel<StudyManifest>("study.json");
  if (!legacyManifest?.series?.length) return;

  const targetId = "current-scan";
  const targetDir = path.join(DATA_DIR, "studies", targetId);
  const targetManifestPath = path.join(targetDir, "study.json");
  if (existsSync(targetManifestPath)) return;

  await fs.mkdir(targetDir, { recursive: true });
  const migratedSeries: StudySeriesSummary[] = [];
  for (const raw of legacyManifest.series) {
    const seriesId = String(raw.series_id ?? "");
    if (!SERIES_ID_RE.test(seriesId)) continue;
    const src = path.join(DATA_DIR, seriesId);
    const dst = path.join(targetDir, seriesId);
    if (!existsSync(src)) continue;
    if (!existsSync(dst)) {
      await fs.cp(src, dst, { recursive: true, errorOnExist: false });
    }
    migratedSeries.push({
      series_id: seriesId,
      modality: String(raw.modality ?? ""),
      series_description: String(raw.series_description ?? ""),
      n_slices: Number(raw.n_slices ?? 0),
    });
  }
  if (migratedSeries.length === 0) return;
  const studyDate = normalizeDate(legacyManifest.study_date);
  const migratedManifest = {
    study_id: targetId,
    label: "Current scan",
    study_date: studyDate ?? "",
    source: asTrimmedString(legacyManifest.source) ?? "",
    source_volume: asTrimmedString(legacyManifest.source_volume) ?? asTrimmedString(legacyManifest.source) ?? "",
    imported_at: new Date().toISOString(),
    series: migratedSeries,
    study_signature: studySignature(studyDate, migratedSeries),
  };
  await fs.writeFile(targetManifestPath, JSON.stringify(migratedManifest, null, 2));
  console.log(`[study-library] migrated legacy extraction to ${targetDir}`);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function uniqueStudyId(base: string): Promise<string> {
  const cleanBase = slugify(base) || `study-${Date.now()}`;
  let candidate = cleanBase.slice(0, 64);
  let i = 2;
  while (existsSync(path.join(DATA_DIR, "studies", candidate))) {
    const suffix = `-${i++}`;
    candidate = `${cleanBase.slice(0, 64 - suffix.length)}${suffix}`;
  }
  return candidate;
}

type InspectSeries = StudySeriesSummary & {
  rows?: number;
  columns?: number;
  frames_per_file?: number;
};

type ImportInspection = {
  path: string;
  volume_name: string;
  study_date?: string;
  suggested_label: string;
  suggested_id: string;
  signature: string;
  series: InspectSeries[];
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

type ImportJob = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  sourcePath: string;
  studyId: string;
  studyLabel: string;
  studyDate?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  log: string[];
  progress: ImportProgress;
};

const importJobs = new Map<string, ImportJob>();
const EXTRACT_PROGRESS_PREFIX = "__LUMEN_PROGRESS__";

function updateImportProgress(job: ImportJob, rawLine: string): boolean {
  const line = rawLine.trim();
  if (!line.startsWith(EXTRACT_PROGRESS_PREFIX)) return false;
  try {
    const payload = JSON.parse(line.slice(EXTRACT_PROGRESS_PREFIX.length)) as {
      phase?: string;
      series_id?: string;
      series_index?: number;
      total_series?: number;
      modality?: string;
      series_description?: string;
      n_slices?: number;
      converted?: number;
      errors?: number;
      error?: string;
    };
    const totalSeries = Math.max(1, Number(payload.total_series ?? job.progress.totalSeries ?? 1));
    const seriesIndex = Math.max(1, Number(payload.series_index ?? job.progress.seriesIndex ?? 1));
    const totalImages = Math.max(0, Number(payload.n_slices ?? job.progress.totalImages ?? 0));
    const converted = Math.max(0, Number(payload.converted ?? job.progress.converted ?? 0));
    const seriesBase = seriesIndex - 1;
    const seriesFraction = totalImages > 0 ? converted / totalImages : 0;
    const percent =
      payload.phase === "complete"
        ? 100
        : Math.max(1, Math.min(99, Math.round(((seriesBase + seriesFraction) / totalSeries) * 100)));
    const label = [payload.modality, payload.series_description || payload.series_id]
      .filter(Boolean)
      .join(" · ");

    if (payload.phase === "start") {
      job.progress = {
        phase: "running",
        percent: 1,
        detail: `Starting import of ${totalSeries} series`,
        totalSeries,
      };
      return true;
    }

    if (payload.phase === "complete") {
      job.progress = {
        phase: "completed",
        percent: 100,
        detail: "Import complete",
        totalSeries,
      };
      return true;
    }

    if (payload.phase === "series_failed") {
      job.progress = {
        phase: "running",
        percent,
        currentItem: payload.series_id,
        detail: `Series ${seriesIndex}/${totalSeries} failed: ${payload.error ?? "unknown error"}`,
        seriesIndex,
        totalSeries,
      };
      return true;
    }

    if (payload.phase?.startsWith("series_")) {
      job.progress = {
        phase: "running",
        percent,
        currentItem: label || payload.series_id,
        detail:
          totalImages > 0
            ? `Series ${seriesIndex}/${totalSeries} · image ${Math.min(converted, totalImages)}/${totalImages}`
            : `Series ${seriesIndex}/${totalSeries}`,
        seriesIndex,
        totalSeries,
        converted,
        totalImages,
      };
      return true;
    }
  } catch {
    return false;
  }
  return true;
}

function runCommand(
  command: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: PROJECT_ROOT });
    let stdout = "";
    let stderr = "";
    const timeout =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error("command_timeout"));
          }, opts.timeoutMs)
        : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 10_000_000) stdout = stdout.slice(-10_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
    });
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`exit_${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function inspectImportSource(sourcePath: string): Promise<ImportInspection> {
  const real = await fs.realpath(sourcePath);
  const { stdout } = await runCommand(PYTHON_BIN, [INSPECT_SCRIPT, real, "--json"], { timeoutMs: 120_000 });
  const parsed = JSON.parse(stdout) as ImportInspection;
  const series = (parsed.series ?? []).map((s) => ({
    ...s,
    n_slices: Number(s.n_slices ?? 0),
  }));
  const studyDate = normalizeDate(parsed.study_date);
  const signature = parsed.signature || studySignature(studyDate, series);
  return {
    ...parsed,
    path: real,
    study_date: studyDate,
    signature,
    series,
    suggested_label:
      asTrimmedString(parsed.suggested_label) ??
      `${studyDate ?? path.basename(real)} scan`,
    suggested_id:
      asTrimmedString(parsed.suggested_id) ??
      slugify(`${studyDate ?? path.basename(real)} scan`),
  };
}

async function findDuplicateStudy(inspection: Pick<ImportInspection, "study_date" | "series" | "signature">) {
  const incomingSig = inspection.signature || studySignature(inspection.study_date, inspection.series);
  const loaded = await loadAllStudies();
  return (
    loaded.find((s) => {
      const sig = s.study.study_signature || studySignature(s.study.study_date, s.study.series);
      return sig === incomingSig;
    })?.study ?? null
  );
}

async function runImportJob(
  job: ImportJob,
  opts: { force: boolean },
): Promise<void> {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.progress = {
    phase: "running",
    percent: 1,
    detail: "Preparing import",
  };
  const targetDir = path.join(DATA_DIR, "studies", job.studyId);
  try {
    if (opts.force) await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const args = [
        EXTRACT_SCRIPT,
        job.sourcePath,
        "--out",
        DATA_DIR,
        "--study-id",
        job.studyId,
        "--study-label",
        job.studyLabel,
        "--study-date",
        job.studyDate ?? "auto",
      ];
      const child = spawn(PYTHON_BIN, args, { cwd: PROJECT_ROOT });
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const appendLine = (line: string) => {
        if (!line.trim()) return;
        if (updateImportProgress(job, line)) return;
        job.log.push(line.slice(0, 800));
        if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
      };
      const append = (text: string, stream: "stdout" | "stderr") => {
        const joined = (stream === "stdout" ? stdoutBuffer : stderrBuffer) + text;
        const lines = joined.split(/\r?\n/);
        const rest = lines.pop() ?? "";
        if (stream === "stdout") stdoutBuffer = rest;
        else stderrBuffer = rest;
        for (const line of lines) {
          appendLine(line);
        }
      };
      child.stdout.on("data", (chunk) => append(chunk.toString(), "stdout"));
      child.stderr.on("data", (chunk) => append(chunk.toString(), "stderr"));
      child.on("error", reject);
      child.on("close", (code) => {
        appendLine(stdoutBuffer);
        appendLine(stderrBuffer);
        if (code === 0) resolve();
        else reject(new Error(`import exited with ${code}`));
      });
    });
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.progress = {
      ...job.progress,
      phase: "completed",
      percent: 100,
      detail: "Import complete",
    };
  } catch (err) {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.error = err instanceof Error ? err.message : String(err);
    job.progress = {
      ...job.progress,
      phase: "failed",
      detail: job.error,
    };
    job.log.push(`FAILED: ${job.error}`);
  }
}

// List available studies + series metadata. Supports both the original
// data/<series>/ layout and the newer data/studies/<study-id>/<series>/ layout.
app.get("/api/study", async (_req: Request, res: Response) => {
  try {
    const loaded = await loadAllStudies();
    res.json({
      studies: loaded.map((s) => s.study),
      series: loaded.flatMap((s) => s.series),
      matchedSeriesGroups: buildMatchedSeriesGroups(loaded),
      disclaimer: SAFETY_DISCLAIMER,
    });
  } catch (err) {
    console.error("[/api/study]", err);
    res.status(500).json({ error: "study_load_failed" });
  }
});

const ImportPathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => path.isAbsolute(value), "path must be absolute");

const ImportInspectSchema = z
  .object({
    path: ImportPathSchema,
  })
  .strict();

const ImportStartSchema = z
  .object({
    path: ImportPathSchema,
    studyId: z.string().regex(SERIES_ID_RE).optional(),
    studyLabel: z.string().trim().min(1).max(120).optional(),
    studyDate: z
      .string()
      .trim()
      .regex(/^$|^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    force: z.boolean().default(false),
  })
  .strict();

const LabelUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    studyDate: z
      .string()
      .trim()
      .regex(/^$|^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

app.get("/api/import/volumes", async (_req: Request, res: Response) => {
  try {
    const entries = await fs.readdir("/Volumes", { withFileTypes: true });
    const volumes = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const volumePath = path.join("/Volumes", e.name);
          const hasImagesDir = existsSync(path.join(volumePath, "images"));
          return { name: e.name, path: volumePath, hasImagesDir };
        }),
    );
    res.json({ volumes });
  } catch (err) {
    console.error("[/api/import/volumes]", err);
    res.status(500).json({ error: "volume_scan_failed" });
  }
});

app.post("/api/import/inspect", async (req: Request, res: Response) => {
  const parsed = ImportInspectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  try {
    const inspection = await inspectImportSource(parsed.data.path);
    const duplicate = await findDuplicateStudy(inspection);
    res.json({
      ...inspection,
      duplicate: duplicate
        ? {
            study_id: duplicate.study_id,
            label: duplicate.label,
            study_date: duplicate.study_date,
          }
        : null,
    });
  } catch (err) {
    console.error("[/api/import/inspect]", err);
    res.status(422).json({ error: "inspect_failed" });
  }
});

app.post("/api/import/start", async (req: Request, res: Response) => {
  const parsed = ImportStartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  try {
    const inspection = await inspectImportSource(parsed.data.path);
    const duplicate = await findDuplicateStudy(inspection);
    if (duplicate && !parsed.data.force) {
      return res.status(409).json({
        error: "duplicate_study",
        duplicate: {
          study_id: duplicate.study_id,
          label: duplicate.label,
          study_date: duplicate.study_date,
        },
      });
    }

    const studyDate = normalizeDate(parsed.data.studyDate) ?? inspection.study_date;
    const studyLabel = parsed.data.studyLabel ?? inspection.suggested_label;
    const studyId =
      parsed.data.studyId ??
      (parsed.data.force && duplicate?.study_id !== LEGACY_STUDY_ID ? duplicate?.study_id : undefined) ??
      (await uniqueStudyId(`${studyDate ?? ""}-${studyLabel || inspection.volume_name || "scan"}`));
    const targetExists = existsSync(path.join(DATA_DIR, "studies", studyId));
    if (targetExists && !parsed.data.force) {
      return res.status(409).json({ error: "study_exists", study_id: studyId });
    }

    const job: ImportJob = {
      jobId: randomUUID(),
      status: "queued",
      sourcePath: inspection.path,
      studyId,
      studyLabel,
      studyDate,
      log: [],
      progress: {
        phase: "queued",
        percent: 0,
        detail: "Queued",
      },
    };
    importJobs.set(job.jobId, job);
    void runImportJob(job, { force: parsed.data.force });
    res.status(202).json({ jobId: job.jobId, studyId, studyLabel, studyDate });
  } catch (err) {
    console.error("[/api/import/start]", err);
    res.status(422).json({ error: "import_start_failed" });
  }
});

app.get("/api/import/jobs/:jobId", (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = importJobs.get(jobId);
  if (!job) return res.status(404).json({ error: "job_not_found" });
  res.json(job);
});

app.post("/api/studies/:studyId/label", async (req: Request, res: Response) => {
  const studyId = StudyIdZ.safeParse(req.params.studyId);
  const body = LabelUpdateSchema.safeParse(req.body);
  if (!studyId.success || !body.success) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const manifestRel =
    studyId.data === LEGACY_STUDY_ID ? "study.json" : path.join("studies", studyId.data, "study.json");
  const manifest = await readJsonRel<StudyManifest>(manifestRel);
  if (!manifest) return res.status(404).json({ error: "study_not_found" });
  const series = (manifest.series ?? [])
    .map((s) => ({
      series_id: String(s.series_id ?? ""),
      modality: String(s.modality ?? ""),
      series_description: String(s.series_description ?? ""),
      n_slices: Number(s.n_slices ?? 0),
    }))
    .filter((s) => SERIES_ID_RE.test(s.series_id));
  const nextDate =
    body.data.studyDate === undefined ? normalizeDate(manifest.study_date) : normalizeDate(body.data.studyDate);
  const nextManifest = {
    ...manifest,
    study_id: studyId.data,
    label: body.data.label,
    study_label: body.data.label,
    study_date: nextDate ?? "",
    study_signature: studySignature(nextDate, series),
    series,
  };
  const real = await safeResolveUnder(DATA_DIR, manifestRel);
  if (!real) return res.status(404).json({ error: "study_not_found" });
  await fs.writeFile(real, JSON.stringify(nextManifest, null, 2));
  res.json(nextManifest);
});

const PNG_MAGIC = "iVBORw0KGgo"; // base64-encoded \x89PNG\r\n\x1a\n

const AskSchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    imageB64: z
      .string()
      .min(100)
      .max(8 * 1024 * 1024)
      .refine((s) => s.startsWith(PNG_MAGIC), "imageB64 is not a PNG"),
    roiB64: z
      .string()
      .min(100)
      .max(2 * 1024 * 1024)
      .refine((s) => s.startsWith(PNG_MAGIC), "roiB64 is not a PNG")
      .optional(),
    sliceIndex: z.number().int().nonnegative().max(10000),
    seriesId: SeriesIdZ,
    studyId: StudyIdZ,
    studyLabel: z.string().max(120).default(""),
    seriesDescription: z.string().max(200).default(""),
    modality: z.string().max(8).default(""),
    question: z.string().min(1).max(2000),
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1).max(8000),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();

app.post("/api/ask", async (req: Request, res: Response) => {
  const parsed = AskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const { provider } = parsed.data;
  const adapter = PROVIDERS[provider as Provider];
  if (!adapter) return res.status(400).json({ error: "unknown_provider" });
  try {
    const scanReportMarkdown = await readLatestScanReport(parsed.data.studyId, parsed.data.seriesId);
    const timelineReportMarkdown = await readLatestTimelineReport(parsed.data.modality, parsed.data.seriesDescription);
    const result = await adapter({ ...parsed.data, scanReportMarkdown, timelineReportMarkdown });
    res.json({
      text: result.text,
      annotations: result.annotations,
      provider: result.provider,
      fallback: result.fallback ?? false,
      disclaimer: SAFETY_DISCLAIMER,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; provider?: string; message?: string };
    if (e?.code === "PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: "provider_not_configured", provider: e.provider });
    }
    console.error(`[${provider}]`, err);
    res.status(502).json({ error: "provider_failed", provider });
  }
});

function scanNotesDir(studyId: string): string {
  if (studyId && studyId !== LEGACY_STUDY_ID) {
    return path.join(DATA_DIR, "studies", studyId, ".lumen", "scan-notes");
  }
  return path.join(DATA_DIR, ".lumen", "scan-notes");
}

async function readLatestScanReport(studyId: string, seriesId: string): Promise<string | undefined> {
  if (!SERIES_ID_RE.test(studyId) || !SERIES_ID_RE.test(seriesId)) return undefined;
  const latestPath = path.join(scanNotesDir(studyId), `latest-${seriesId}.md`);
  try {
    const text = await fs.readFile(latestPath, "utf8");
    return text.slice(0, 50_000);
  } catch {
    return undefined;
  }
}

function timelineReportsDir(): string {
  return path.join(DATA_DIR, ".lumen", "timeline-reports");
}

function timelineReportSlugForGroup(groupKey: string): string {
  return slugify(groupKey) || "timeline-report";
}

async function readLatestTimelineReport(modality: string, seriesDescription: string): Promise<string | undefined> {
  const groupKey = matchGroupKey({
    modality,
    series_description: seriesDescription,
  });
  const latestPath = path.join(timelineReportsDir(), `latest-${timelineReportSlugForGroup(groupKey)}.md`);
  try {
    const text = await fs.readFile(latestPath, "utf8");
    return text.slice(0, 75_000);
  } catch {
    return undefined;
  }
}

const CompareSeriesContextZ = z
  .object({
    studyId: StudyIdZ,
    studyLabel: z.string().max(120).default(""),
    seriesId: SeriesIdZ,
    seriesDescription: z.string().max(200).default(""),
    modality: z.string().max(8).default(""),
    sliceIndex: z.number().int().nonnegative().max(10000),
    totalSlices: z.number().int().positive().max(10000),
  })
  .strict();

const CompareSchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    currentImageB64: z
      .string()
      .min(100)
      .max(8 * 1024 * 1024)
      .refine((s) => s.startsWith(PNG_MAGIC), "currentImageB64 is not a PNG"),
    priorImageB64: z
      .string()
      .min(100)
      .max(8 * 1024 * 1024)
      .refine((s) => s.startsWith(PNG_MAGIC), "priorImageB64 is not a PNG"),
    current: CompareSeriesContextZ,
    prior: CompareSeriesContextZ,
    question: z.string().max(1000).optional(),
  })
  .strict();

app.post("/api/compare", async (req: Request, res: Response) => {
  const parsed = CompareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const { provider } = parsed.data;
  const adapter = COMPARE_PROVIDERS[provider as Provider];
  if (!adapter) return res.status(400).json({ error: "unknown_provider" });
  try {
    const result = await adapter(parsed.data);
    res.json({
      text: result.text,
      provider: result.provider,
      fallback: result.fallback ?? false,
      disclaimer: SAFETY_DISCLAIMER,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; provider?: string; message?: string };
    if (e?.code === "PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: "provider_not_configured", provider: e.provider });
    }
    console.error(`[compare ${provider}]`, err);
    res.status(502).json({ error: "compare_failed", provider });
  }
});

const ProgressionSchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    groupKey: z.string().min(1).max(300),
    studyIds: z.array(StudyIdZ).min(2).max(8).optional(),
  })
  .strict();

app.post("/api/progression/report", async (req: Request, res: Response) => {
  const parsed = ProgressionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const adapter = PROGRESSION_PROVIDERS[parsed.data.provider as Provider];
  if (!adapter) return res.status(400).json({ error: "unknown_provider" });

  try {
    const loaded = await loadAllStudies();
    const group = buildMatchedSeriesGroups(loaded).find((g) => g.group_key === parsed.data.groupKey);
    if (!group) return res.status(404).json({ error: "series_group_not_found" });
    const allowedStudyIds = parsed.data.studyIds ? new Set(parsed.data.studyIds) : null;
    const selectedRaw = group.studies.filter((s) => !allowedStudyIds || allowedStudyIds.has(s.study_id));
    const seenStudyIds = new Set<string>();
    const selected = selectedRaw.filter((s) => {
      if (seenStudyIds.has(s.study_id)) return false;
      seenStudyIds.add(s.study_id);
      return true;
    });
    if (new Set(selected.map((s) => s.study_id)).size < 2) {
      return res.status(400).json({ error: "need_at_least_two_studies" });
    }

    const studiesForModel = await Promise.all(
      selected.slice(-6).map(async (s) => {
        const indices = sampleIndices(s.n_slices, Math.min(3, s.n_slices));
        const sampledSlices = await loadSlicesFromDisk(DATA_DIR, s.series_id, indices, s.study_id);
        return {
          studyId: s.study_id,
          studyLabel: s.study_label,
          studyDate: s.study_date,
          seriesId: s.series_id,
          totalSlices: s.n_slices,
          sampledSlices,
        };
      }),
    );
    const result = await adapter({
      provider: parsed.data.provider as Provider,
      seriesGroup: {
        groupKey: group.group_key,
        label: group.label,
        modality: group.modality,
        seriesDescription: group.series_description,
      },
      studies: studiesForModel,
    });
    res.json({
      text: result.text,
      provider: result.provider,
      fallback: result.fallback ?? false,
      disclaimer: SAFETY_DISCLAIMER,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; provider?: string; message?: string };
    if (e?.code === "PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: "provider_not_configured", provider: e.provider });
    }
    console.error("[/api/progression/report]", err);
    res.status(502).json({ error: "progression_failed", provider: parsed.data.provider });
  }
});

// ---------- Whole-scan progression compare jobs ----------

const SCAN_ANALYSIS_SCHEMA_VERSION = "scan-analysis-v1";
const PROGRESSION_COMPARE_SCHEMA_VERSION = "progression-compare-v1";

const PROVIDER_MODEL: Record<Provider, string> = {
  claude: "claude-opus-4-7",
  gpt5: "gpt-5.5",
  gemini: "gemini-2.5-pro",
};

type ScanAnalysisRun = {
  schemaVersion: string;
  studyId: string;
  studyLabel: string;
  studyDate?: string;
  seriesId: string;
  seriesDescription: string;
  modality: string;
  totalSlices: number;
  provider: Provider;
  model: string;
  createdAt: string;
  rois: ROI[];
  findings: ScanFinding[];
  summaries: {
    survey: string;
    zoom?: string;
    deep?: string;
  };
  inspectedIndices: number[];
  fallback?: boolean;
};

type CompareEvidence = {
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
  severity: ScanFinding["severity"];
};

type ComparisonFindingGroup = {
  groupId: string;
  status:
    | "seen_across_dates"
    | "later_date_only"
    | "earlier_date_only"
    | "changed_appearance_or_extent"
    | "uncertain_match";
  title: string;
  visibleChangeSummary: string;
  confidence: number;
  limitations: string[];
  oncologistQuestions: string[];
  evidence: CompareEvidence[];
};

type ProgressionCompareResult = {
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

type ProgressionCompareHistoryItem = {
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

type ProgressionCompareProgress = {
  phase: "queued" | "scanning" | "matching" | "summarizing" | "completed" | "failed";
  percent: number;
  detail?: string;
  currentStudy?: string;
  completedStudies?: number;
  totalStudies?: number;
};

type ProgressionCompareJob = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  provider: Provider;
  groupKey: string;
  studyIds: string[];
  startedAt?: string;
  completedAt?: string;
  resultId?: string;
  error?: string;
  progress: ProgressionCompareProgress;
};

const progressionCompareJobs = new Map<string, ProgressionCompareJob>();
const progressionCompareResults = new Map<string, ProgressionCompareResult>();

const ProgressionCompareStartSchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    groupKey: z.string().min(1).max(300),
    studyIds: z.array(StudyIdZ).min(2).max(8),
  })
  .strict();

const ProgressionCompareHistoryQuerySchema = z
  .object({
    groupKey: z.string().min(1).max(300).optional(),
  })
  .strict();

function analysisCachePath(studyId: string, seriesId: string, provider: Provider): string {
  const file = `${seriesId}-${provider}-${SCAN_ANALYSIS_SCHEMA_VERSION}.json`;
  if (studyId === LEGACY_STUDY_ID) {
    return path.join(DATA_DIR, ".lumen", "analysis", file);
  }
  return path.join(DATA_DIR, "studies", studyId, ".lumen", "analysis", file);
}

async function readAnalysisCache(
  study: SeriesRecord,
  provider: Provider,
): Promise<ScanAnalysisRun | null> {
  const cachePath = analysisCachePath(study.study_id, study.series_id, provider);
  try {
    const raw = JSON.parse(await fs.readFile(cachePath, "utf8")) as ScanAnalysisRun;
    if (
      raw.schemaVersion !== SCAN_ANALYSIS_SCHEMA_VERSION ||
      raw.provider !== provider ||
      raw.model !== PROVIDER_MODEL[provider] ||
      raw.studyId !== study.study_id ||
      raw.seriesId !== study.series_id
    ) {
      return null;
    }
    if (!Array.isArray(raw.findings) || !Array.isArray(raw.rois)) return null;
    return raw;
  } catch {
    return null;
  }
}

async function writeAnalysisCache(run: ScanAnalysisRun): Promise<void> {
  const cachePath = analysisCachePath(run.studyId, run.seriesId, run.provider);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(run, null, 2));
  await fs.rename(tmp, cachePath);
}

async function analyzeSeriesForComparison(
  study: SeriesRecord,
  provider: Provider,
  progress: (detail: string) => void,
): Promise<{ analysis: ScanAnalysisRun; cacheStatus: "hit" | "miss" }> {
  const cached = await readAnalysisCache(study, provider);
  if (cached) {
    progress(`Using cached analysis for ${study.study_label}`);
    return { analysis: cached, cacheStatus: "hit" };
  }

  const base = {
    provider,
    studyId: study.study_id,
    seriesId: study.series_id,
    seriesDescription: study.series_description,
    modality: study.modality,
    totalSlices: study.n_slices,
    dataDir: DATA_DIR,
  };

  progress(`Surveying ${study.study_label}`);
  const survey = await runSurvey(base);
  if (survey.rois.length === 0) {
    const emptyRun: ScanAnalysisRun = {
      schemaVersion: SCAN_ANALYSIS_SCHEMA_VERSION,
      studyId: study.study_id,
      studyLabel: study.study_label,
      studyDate: study.study_date,
      seriesId: study.series_id,
      seriesDescription: study.series_description,
      modality: study.modality,
      totalSlices: study.n_slices,
      provider,
      model: PROVIDER_MODEL[provider],
      createdAt: new Date().toISOString(),
      rois: [],
      findings: [],
      summaries: { survey: survey.text },
      inspectedIndices: survey.sampledIndices,
      fallback: survey.fallback ?? false,
    };
    await writeAnalysisCache(emptyRun);
    return { analysis: emptyRun, cacheStatus: "miss" };
  }

  progress(`Zooming into ${survey.rois.length} region${survey.rois.length === 1 ? "" : "s"} in ${study.study_label}`);
  const zoom = await runZoom(base, survey.rois);
  const topRegions = survey.rois
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 5);

  progress(`Deep-reviewing top regions in ${study.study_label}`);
  const deep = topRegions.length > 0 ? await runDeep(base, topRegions) : null;
  const finalFindings = deep?.findings.length ? deep.findings : zoom.findings;
  const inspected = new Set<number>([
    ...survey.sampledIndices,
    ...zoom.inspectedIndices,
    ...(deep?.inspectedIndices ?? []),
  ]);

  const run: ScanAnalysisRun = {
    schemaVersion: SCAN_ANALYSIS_SCHEMA_VERSION,
    studyId: study.study_id,
    studyLabel: study.study_label,
    studyDate: study.study_date,
    seriesId: study.series_id,
    seriesDescription: study.series_description,
    modality: study.modality,
    totalSlices: study.n_slices,
    provider,
    model: PROVIDER_MODEL[provider],
    createdAt: new Date().toISOString(),
    rois: survey.rois,
    findings: finalFindings,
    summaries: {
      survey: survey.text,
      zoom: zoom.text,
      deep: deep?.text,
    },
    inspectedIndices: [...inspected].sort((a, b) => a - b),
    fallback: survey.fallback || zoom.fallback || deep?.fallback || false,
  };
  await writeAnalysisCache(run);
  return { analysis: run, cacheStatus: "miss" };
}

function stopWords(): Set<string> {
  return new Set([
    "the",
    "and",
    "with",
    "scan",
    "image",
    "area",
    "region",
    "right",
    "left",
    "upper",
    "lower",
    "mid",
    "possible",
    "activity",
    "uptake",
    "focal",
  ]);
}

function tokenizeForMatch(value: string): Set<string> {
  const stops = stopWords();
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stops.has(w)),
  );
}

function regionOverlap(a: string, b: string): number {
  const at = tokenizeForMatch(a);
  const bt = tokenizeForMatch(b);
  if (at.size === 0 || bt.size === 0) return 0;
  let same = 0;
  for (const token of at) if (bt.has(token)) same += 1;
  return same / Math.max(1, Math.min(at.size, bt.size));
}

function evidenceMatchScore(a: CompareEvidence, b: CompareEvidence): number {
  const regionScore = regionOverlap(a.region, b.region) * 0.42;
  const sliceDiff = Math.abs(a.relativeSlice - b.relativeSlice);
  const sliceScore = Math.max(0, 1 - sliceDiff / 0.12) * 0.34;
  const xyDist = Math.hypot(a.xNorm - b.xNorm, a.yNorm - b.yNorm);
  const xyScore = Math.max(0, 1 - xyDist / 0.28) * 0.24;
  if (regionScore === 0 && sliceDiff > 0.06) return 0;
  return regionScore + sliceScore + xyScore;
}

function toEvidence(analysis: ScanAnalysisRun, finding: ScanFinding): CompareEvidence {
  return {
    studyId: analysis.studyId,
    studyLabel: analysis.studyLabel,
    studyDate: analysis.studyDate,
    seriesId: analysis.seriesId,
    seriesKey: `${analysis.studyId}:${analysis.seriesId}`,
    sliceIndex: finding.sliceIndex,
    relativeSlice: analysis.totalSlices > 1 ? finding.sliceIndex / (analysis.totalSlices - 1) : 0,
    xNorm: finding.xNorm,
    yNorm: finding.yNorm,
    radiusNorm: finding.radiusNorm,
    region: finding.region,
    observation: finding.observation,
    possibleMeanings: finding.possibleMeanings,
    healthyComparison: finding.healthyComparison,
    questionsForOncologist: finding.questionsForOncologist,
    confidence: finding.confidence,
    severity: finding.severity,
  };
}

function groupTitle(evidence: CompareEvidence[]): string {
  const sorted = evidence.slice().sort((a, b) => b.confidence - a.confidence);
  return sorted[0]?.region || "Visible finding candidate";
}

function hasMeaningfulVisibleDifference(evidence: CompareEvidence[]): boolean {
  if (evidence.length < 2) return false;
  const rel = evidence.map((e) => e.relativeSlice);
  const conf = evidence.map((e) => e.confidence);
  const radius = evidence.map((e) => e.radiusNorm);
  const range = (values: number[]) => Math.max(...values) - Math.min(...values);
  return range(rel) > 0.08 || range(conf) > 0.35 || range(radius) > 0.08;
}

function makeGroupSummary(
  status: ComparisonFindingGroup["status"],
  evidence: CompareEvidence[],
  latestStudyId: string,
): string {
  const labels = evidence
    .slice()
    .sort((a, b) => (a.studyDate ?? "").localeCompare(b.studyDate ?? ""))
    .map((e) => e.studyDate || e.studyLabel);
  const joined = labels.join(", ");
  switch (status) {
    case "later_date_only":
      return `Detected only on the latest selected study (${joined}). This is a visible candidate to review, but it may reflect slice coverage, windowing, physiologic uptake, inflammation, or a technical difference.`;
    case "earlier_date_only":
      return `Detected on earlier selected date(s) (${joined}) but not re-detected by this AI pass on the latest selected study. Ask the care team whether the official comparison sees this area and how they interpret it.`;
    case "changed_appearance_or_extent":
      return `Detected on multiple selected dates (${joined}), with visible position, size, or confidence differences large enough to review side by side in the clinical viewer.`;
    case "seen_across_dates":
      return `Detected across the selected dates (${joined}). This app can show the visual similarity, but the official comparison is needed for measurements and clinical interpretation.`;
    case "uncertain_match":
      return `Partially matched across selected date(s) (${joined}), but the location or wording does not line up cleanly enough for the app to treat it as the same area.`;
  }
}

function plainStatusLabel(status: ComparisonFindingGroup["status"]): string {
  switch (status) {
    case "seen_across_dates":
      return "flagged on the selected dates";
    case "later_date_only":
      return "flagged only on the latest selected scan";
    case "earlier_date_only":
      return "flagged on an earlier scan but not matched on the latest selected scan";
    case "changed_appearance_or_extent":
      return "flagged on multiple scans and looked visibly different";
    case "uncertain_match":
      return "possible match, but uncertain";
  }
}

function plainStatusExplanation(status: ComparisonFindingGroup["status"]): string {
  switch (status) {
    case "later_date_only":
      return "Lumen flagged this area on the latest selected scan and did not match it on the earlier selected scans. Ask whether the official report considers it new, more visible, or a technical/physiologic difference.";
    case "earlier_date_only":
      return "Lumen flagged this area on an earlier selected scan but did not match it on the latest selected scan. Ask whether the care team still sees it, whether it changed, or whether scan technique made it harder to compare.";
    case "changed_appearance_or_extent":
      return "Lumen matched this area on more than one selected scan and the visible appearance differed enough to review side by side. This is not a growth or response measurement.";
    case "seen_across_dates":
      return "Lumen matched this area across the selected scans. The app can show where it was flagged, but official measurements and clinical interpretation are needed.";
    case "uncertain_match":
      return "Lumen found similar-looking areas, but the match is not reliable enough to treat them as the same finding without the official viewer.";
  }
}

function studyReportLabel(study: Pick<ProgressionCompareResult["studies"][number], "studyDate" | "studyLabel">): string {
  return study.studyDate ? `${study.studyDate} (${study.studyLabel})` : study.studyLabel;
}

function evidenceForStudy(group: ComparisonFindingGroup, studyId: string): CompareEvidence[] {
  return group.evidence
    .filter((e) => e.studyId === studyId)
    .slice()
    .sort((a, b) => {
      if (a.sliceIndex !== b.sliceIndex) return a.sliceIndex - b.sliceIndex;
      return b.confidence - a.confidence;
    });
}

function evidenceSummaryForStudy(evidence: CompareEvidence[]): string {
  if (evidence.length === 0) {
    return "not matched by this AI pass";
  }
  const top = evidence.slice().sort((a, b) => b.confidence - a.confidence)[0];
  const imageList = evidence
    .map((e) => e.sliceIndex + 1)
    .slice(0, 4)
    .join(", ");
  const suffix = evidence.length > 4 ? `, plus ${evidence.length - 4} more` : "";
  return `flagged on image ${imageList}${suffix}. ${markdownLine(top.observation)}`;
}

function buildPatientTimelineBlock(
  group: ComparisonFindingGroup,
  studies: ProgressionCompareResult["studies"],
  prefix = "- ",
): string[] {
  return studies.map((study) => {
    const evidence = evidenceForStudy(group, study.studyId);
    return `${prefix}${studyReportLabel(study)}: ${evidenceSummaryForStudy(evidence)}`;
  });
}

function groupQuestions(group: Pick<ComparisonFindingGroup, "title" | "status">, modality: string): string[] {
  const questions = [
    `Can you compare the "${group.title}" area across the official dated studies in the clinical viewer?`,
    "Is there a CT correlate, size measurement, or target/non-target lesion note for this area?",
    "Could treatment effect, inflammation, infection, physiologic uptake, or scanner/windowing differences explain the visible appearance?",
  ];
  if (modality.toUpperCase() === "PT") {
    questions.splice(1, 0, "What were the SUVmax/SULpeak and background liver or blood-pool values for this area on each date?");
  }
  if (group.status === "later_date_only") {
    questions.push("Does the official report consider this a new finding, or was it present but less visible on the prior study?");
  }
  if (group.status === "earlier_date_only") {
    questions.push("Does the care team still see this area on the latest study, even if this app did not re-detect it?");
  }
  return questions.slice(0, 5);
}

function buildComparisonGroups(
  analyses: ScanAnalysisRun[],
  selectedStudyIds: string[],
  modality: string,
): ComparisonFindingGroup[] {
  const working: { evidence: CompareEvidence[] }[] = [];
  for (const analysis of analyses) {
    for (const finding of analysis.findings) {
      if (finding.severity === "clearly-physiologic") continue;
      const evidence = toEvidence(analysis, finding);
      let best: { index: number; score: number } | null = null;
      for (let index = 0; index < working.length; index += 1) {
        const group = working[index];
        const score = Math.max(...group.evidence.map((existing) => evidenceMatchScore(existing, evidence)));
        if (!best || score > best.score) best = { index, score };
      }
      if (best && best.score >= 0.48) {
        working[best.index].evidence.push(evidence);
      } else {
        working.push({ evidence: [evidence] });
      }
    }
  }

  const latestStudyId = selectedStudyIds[selectedStudyIds.length - 1];
  const limits = comparisonLimitations();
  return working
    .map((group, index): ComparisonFindingGroup => {
      const evidence = group.evidence.sort((a, b) => {
        const ad = a.studyDate ?? "";
        const bd = b.studyDate ?? "";
        if (ad !== bd) return ad.localeCompare(bd);
        return a.studyLabel.localeCompare(b.studyLabel);
      });
      const evidenceStudyIds = new Set(evidence.map((e) => e.studyId));
      let status: ComparisonFindingGroup["status"];
      if (evidenceStudyIds.size === selectedStudyIds.length) {
        status = hasMeaningfulVisibleDifference(evidence) ? "changed_appearance_or_extent" : "seen_across_dates";
      } else if (evidenceStudyIds.size === 1 && evidenceStudyIds.has(latestStudyId)) {
        status = "later_date_only";
      } else if (!evidenceStudyIds.has(latestStudyId)) {
        status = "earlier_date_only";
      } else {
        status = "uncertain_match";
      }
      const title = groupTitle(evidence);
      const confidence = evidence.reduce((sum, e) => sum + e.confidence, 0) / Math.max(1, evidence.length);
      const base = { groupId: `cmp-${index + 1}`, status, title, evidence, confidence };
      return {
        ...base,
        visibleChangeSummary: makeGroupSummary(status, evidence, latestStudyId),
        limitations: limits,
        oncologistQuestions: groupQuestions(base, modality),
      };
    })
    .sort((a, b) => {
      const weight: Record<ComparisonFindingGroup["status"], number> = {
        later_date_only: 0,
        changed_appearance_or_extent: 1,
        earlier_date_only: 2,
        uncertain_match: 3,
        seen_across_dates: 4,
      };
      const byWeight = weight[a.status] - weight[b.status];
      if (byWeight !== 0) return byWeight;
      return b.confidence - a.confidence;
    });
}

function comparisonLimitations(): string[] {
  return [
    "This uses rendered PNG images from the local study library, not a registered clinical workstation.",
    "The app does not calculate SUVmax, SULpeak, lesion diameters, RECIST, or PERCIST categories.",
    "Slice position, patient positioning, reconstruction, windowing, and scanner protocol can change what appears visible.",
    "Any later-date-only or earlier-date-only detection needs official radiology comparison before it means anything clinically.",
  ];
}

function buildComparisonReport(result: Omit<ProgressionCompareResult, "text" | "disclaimer">): string {
  const dateList = result.studies.map((s) => s.studyDate || s.studyLabel).join(", ");
  const lines: string[] = [
    `Area-by-area scan timeline for ${result.seriesGroup.label}`,
    "",
    `Dates reviewed: ${dateList || "selected studies"}.`,
    "",
    "How to read this:",
    "- These are AI-flagged cancer-related areas to ask the oncology team about, not confirmed cancer findings.",
    "- The app compares visible patterns across scans. It does not measure tumor size, SUV/SUL, or clinical progression.",
    "- If an area says \"not matched,\" that means this AI pass did not confidently match it on that date. It does not mean the area is gone.",
    "",
    "Limitations:",
    ...result.limitations.map((l) => `- ${l}`),
    "",
  ];

  if (result.groups.length === 0) {
    lines.push(
      "No structured finding candidates were produced by the scan pass for this selected scan type. That does not mean the studies are normal or unchanged; it only means this app did not produce comparable visible candidates.",
      "",
    );
  } else {
    lines.push("Area-by-area timeline:");
    for (const group of result.groups.slice(0, 10)) {
      lines.push(
        "",
        `${group.title}: ${plainStatusLabel(group.status)}.`,
        plainStatusExplanation(group.status),
        ...buildPatientTimelineBlock(group, result.studies, "  - "),
      );
    }
    if (result.groups.length > 10) {
      lines.push(`- ${result.groups.length - 10} additional lower-priority group(s) are listed in the result cards.`);
    }
    lines.push("");
  }

  lines.push("Ask the oncologist:");
  const questionSet = new Set<string>();
  for (const group of result.groups.slice(0, 4)) {
    for (const q of group.oncologistQuestions) questionSet.add(q);
  }
  if (questionSet.size === 0) {
    questionSet.add("Can you compare these dated PET/CT studies side by side in the official clinical viewer?");
    questionSet.add("Which areas, if any, changed on the radiology reports and quantitative measurements?");
    questionSet.add("For PET findings, what were the SUVmax/SULpeak and background reference values on each date?");
  }
  for (const q of [...questionSet].slice(0, 8)) lines.push(`- ${q}`);
  return lines.join("\n");
}

function markdownTableCell(value: unknown): string {
  return markdownLine(value).replace(/\|/g, "\\|") || " ";
}

function timelineImageMarkdownRef(studyId: string, seriesId: string, sliceIndex: number): {
  filename: string;
  relativePath: string;
  browserPath: string;
} {
  const filename = sliceFilename(sliceIndex);
  const dataRelativePath = seriesRelPath(studyId, seriesId, filename).split(path.sep).join("/");
  return {
    filename,
    relativePath: `../../${dataRelativePath}`,
    browserPath: `/data/${dataRelativePath}`,
  };
}

function buildTimelineMarkdownReport(result: ProgressionCompareResult): string {
  const dateList = result.studies.map((s) => s.studyDate || s.studyLabel).join(", ");
  const questionSet = new Set<string>();
  for (const group of result.groups.slice(0, 8)) {
    for (const question of group.oncologistQuestions) questionSet.add(question);
  }
  questionSet.add("Can you compare these selected dates side by side in the official radiology viewer?");
  questionSet.add("For PET findings, what were the SUVmax/SULpeak and background reference values on each date?");
  questionSet.add("Which areas have a CT correlate, and could inflammation, infection, or treatment effect explain any uptake?");

  const lines: string[] = [
    "# Lumen Area-by-Area Timeline Report",
    "",
    `- Created: ${result.createdAt}`,
    `- Scan type: ${markdownLine(result.seriesGroup.label)}`,
    `- Modality: ${markdownLine(result.seriesGroup.modality || "unknown")}`,
    `- Series description: ${markdownLine(result.seriesGroup.seriesDescription || "unknown")}`,
    `- Dates reviewed: ${markdownLine(dateList || "selected studies")}`,
    `- AI model: ${result.provider}`,
    "",
    "## Purpose and limits",
    "",
    "This report is meant to answer a practical question: which cancer-related areas did Lumen flag on each selected scan, and how did those visible areas appear to change over time?",
    "",
    "The areas below are AI-flagged areas to ask about. They are not confirmed cancer findings. This is not a diagnosis, official radiology report, treatment decision, or proof of progression, response, worsening, remission, or spread.",
    "",
    "If an area says \"not matched by this AI pass,\" that does not mean the area is gone. It means Lumen did not confidently match the same visible area on that selected date.",
    "",
    "Important limits:",
    ...result.limitations.map((limit) => `- ${markdownLine(limit)}`),
    "",
    "## Timeline",
    "",
    "| Date | Scan label | Images | Findings saved | Cache |",
    "| --- | --- | ---: | ---: | --- |",
    ...result.studies.map(
      (study) =>
        `| ${markdownTableCell(study.studyDate || study.studyLabel)} | ${markdownTableCell(study.studyLabel)} | ${study.totalSlices} | ${study.findingCount} | ${study.cacheStatus} |`,
    ),
    "",
    "## Plain-English summary",
    "",
    markdownLine(result.text),
    "",
    "## Area-by-area scan timeline",
    "",
  ];

  if (result.groups.length === 0) {
    lines.push(
      "No structured finding candidates were saved for this selected scan type. That does not mean the scans are normal or unchanged; it only means Lumen did not produce comparable visible candidates.",
      "",
    );
  } else {
    for (const [index, group] of result.groups.entries()) {
      lines.push(
        `### ${index + 1}. ${markdownLine(group.title)}`,
        "",
        `- Status: ${plainStatusLabel(group.status)}`,
        `- Average AI confidence: ${(group.confidence * 100).toFixed(0)}%`,
        `- Plain-English meaning: ${plainStatusExplanation(group.status)}`,
        `- Technical summary: ${markdownLine(group.visibleChangeSummary)}`,
        "",
      );
      if (group.limitations.length > 0) {
        lines.push("Limitations for this group:", ...group.limitations.map((limit) => `- ${markdownLine(limit)}`), "");
      }

      lines.push(
        "#### Scan-by-scan timeline",
        "",
        "| Scan date | Did Lumen flag this area? | What it saw | Image reference |",
        "| --- | --- | --- | --- |",
      );
      for (const study of result.studies) {
        const evidence = evidenceForStudy(group, study.studyId);
        if (evidence.length === 0) {
          lines.push(
            `| ${markdownTableCell(studyReportLabel(study))} | Not matched by this AI pass | This does not prove the area resolved or disappeared. It only means Lumen did not confidently match it on this date. |  |`,
          );
          continue;
        }
        const top = evidence.slice().sort((a, b) => b.confidence - a.confidence)[0];
        const images = evidence
          .map((e) => `image ${e.sliceIndex + 1}`)
          .slice(0, 4)
          .join(", ");
        const ref = timelineImageMarkdownRef(top.studyId, top.seriesId, top.sliceIndex);
        lines.push(
          `| ${markdownTableCell(studyReportLabel(study))} | Flagged | ${markdownTableCell(markdownLine(top.observation))} | ${markdownTableCell(`${images}; ${ref.browserPath}`)} |`,
        );
      }

      lines.push("", "#### Reference images", "");
      for (const evidence of group.evidence.slice().sort((a, b) => (a.studyDate ?? "").localeCompare(b.studyDate ?? ""))) {
        const ref = timelineImageMarkdownRef(evidence.studyId, evidence.seriesId, evidence.sliceIndex);
        lines.push(
          `- ${markdownLine(evidence.studyDate || evidence.studyLabel)}: image ${evidence.sliceIndex + 1} (zero-based slice ${evidence.sliceIndex})`,
          `  - Local image file: \`${ref.relativePath}\``,
          `  - Browser image path: \`${ref.browserPath}\``,
          `  - Normalized location: x=${evidence.xNorm.toFixed(3)}, y=${evidence.yNorm.toFixed(3)}, radius=${evidence.radiusNorm.toFixed(3)}`,
          `  - What Lumen saw: ${markdownLine(evidence.observation)}`,
          "",
          `![${markdownLine(evidence.studyDate || evidence.studyLabel)} image ${evidence.sliceIndex + 1}](${ref.relativePath})`,
          "",
        );
      }
      lines.push("#### Ask the oncologist", "", markdownBullets(group.oncologistQuestions), "");
    }
  }

  lines.push(
    "## General questions to ask",
    "",
    markdownBullets([...questionSet].slice(0, 10)),
    "",
    "## Follow-up use",
    "",
    "When you ask Lumen follow-up questions about this same scan type, the app will automatically include the latest saved timeline report as context along with the visible image. Treat this report as memory and navigation help, not as medical truth.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

async function writeProgressionResult(result: ProgressionCompareResult): Promise<void> {
  const resultDir = path.join(DATA_DIR, ".lumen", "progression-results");
  const reportDir = timelineReportsDir();
  const slug = timelineReportSlugForGroup(result.seriesGroup.groupKey);
  const reportPath = path.join(reportDir, `${result.resultId}-${slug}.md`);
  const latestPath = path.join(reportDir, `latest-${slug}.md`);
  result.reportPath = reportPath;
  result.latestPath = latestPath;
  const markdown = buildTimelineMarkdownReport(result);
  await fs.mkdir(resultDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, markdown, "utf8");
  await fs.writeFile(latestPath, markdown, "utf8");
  await fs.writeFile(path.join(resultDir, `${result.resultId}.json`), JSON.stringify(result, null, 2), "utf8");
}

function progressionResultJsonPath(resultId: string): string {
  return path.join(DATA_DIR, ".lumen", "progression-results", `${resultId}.json`);
}

async function readProgressionResult(resultId: string): Promise<ProgressionCompareResult | null> {
  const cached = progressionCompareResults.get(resultId);
  if (cached) return cached;
  try {
    const raw = JSON.parse(await fs.readFile(progressionResultJsonPath(resultId), "utf8")) as ProgressionCompareResult;
    if (raw.resultId !== resultId) return null;
    progressionCompareResults.set(raw.resultId, raw);
    return raw;
  } catch {
    return null;
  }
}

function pathIsUnderData(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const base = path.resolve(DATA_DIR);
  return resolved === base || resolved.startsWith(base + path.sep);
}

async function removeFileUnderData(candidate: string | undefined): Promise<void> {
  if (!candidate || !pathIsUnderData(candidate)) return;
  await fs.rm(candidate, { force: true });
}

function progressionHistoryItem(result: ProgressionCompareResult): ProgressionCompareHistoryItem {
  return {
    resultId: result.resultId,
    createdAt: result.createdAt,
    provider: result.provider,
    seriesGroup: result.seriesGroup,
    studies: result.studies,
    groupCount: result.groups.length,
    reportPath: result.reportPath,
    latestPath: result.latestPath,
    textPreview: markdownLine(result.text).slice(0, 240),
  };
}

async function listProgressionHistory(groupKey?: string): Promise<ProgressionCompareHistoryItem[]> {
  const resultDir = path.join(DATA_DIR, ".lumen", "progression-results");
  try {
    const entries = await fs.readdir(resultDir, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            const raw = JSON.parse(await fs.readFile(path.join(resultDir, entry.name), "utf8")) as ProgressionCompareResult;
            if (!raw?.resultId || !raw?.seriesGroup?.groupKey) return null;
            if (groupKey && raw.seriesGroup.groupKey !== groupKey) return null;
            progressionCompareResults.set(raw.resultId, raw);
            return progressionHistoryItem(raw);
          } catch {
            return null;
          }
        }),
    );
    return items
      .filter(Boolean)
      .sort((a, b) => String(b!.createdAt).localeCompare(String(a!.createdAt))) as ProgressionCompareHistoryItem[];
  } catch {
    return [];
  }
}

async function refreshLatestTimelineReport(groupKey: string): Promise<void> {
  const slug = timelineReportSlugForGroup(groupKey);
  const latestPath = path.join(timelineReportsDir(), `latest-${slug}.md`);
  const remaining = await listProgressionHistory(groupKey);
  const nextLatest = remaining[0];
  if (!nextLatest?.reportPath) {
    await removeFileUnderData(latestPath);
    return;
  }
  const source = path.resolve(nextLatest.reportPath);
  if (!pathIsUnderData(source)) {
    await removeFileUnderData(latestPath);
    return;
  }
  try {
    const markdown = await fs.readFile(source, "utf8");
    await fs.writeFile(latestPath, markdown, "utf8");
  } catch {
    await removeFileUnderData(latestPath);
  }
}

async function deleteProgressionResult(resultId: string): Promise<ProgressionCompareResult | null> {
  const result = await readProgressionResult(resultId);
  if (!result) return null;
  const slug = timelineReportSlugForGroup(result.seriesGroup.groupKey);
  await removeFileUnderData(result.reportPath ?? path.join(timelineReportsDir(), `${resultId}-${slug}.md`));
  await removeFileUnderData(progressionResultJsonPath(resultId));
  progressionCompareResults.delete(resultId);
  await refreshLatestTimelineReport(result.seriesGroup.groupKey);
  return result;
}

async function runProgressionCompareJob(job: ProgressionCompareJob): Promise<void> {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  try {
    const loaded = await loadAllStudies();
    const group = buildMatchedSeriesGroups(loaded).find((g) => g.group_key === job.groupKey);
    if (!group) throw new Error("series_group_not_found");
    const requested = new Set(job.studyIds);
    const selected: SeriesRecord[] = [];
    const seenStudyIds = new Set<string>();
    for (const entry of group.studies) {
      if (!requested.has(entry.study_id) || seenStudyIds.has(entry.study_id)) continue;
      selected.push(entry);
      seenStudyIds.add(entry.study_id);
    }
    if (selected.length < 2) throw new Error("need_at_least_two_studies");

    const analyses: { analysis: ScanAnalysisRun; cacheStatus: "hit" | "miss"; series: SeriesRecord }[] = [];
    for (const [index, study] of selected.entries()) {
      const basePercent = Math.round((index / selected.length) * 72);
      job.progress = {
        phase: "scanning",
        percent: Math.max(1, basePercent),
        currentStudy: study.study_label,
        completedStudies: index,
        totalStudies: selected.length,
        detail: `Preparing ${study.study_label}`,
      };
      const analyzed = await analyzeSeriesForComparison(study, job.provider, (detail) => {
        job.progress = {
          ...job.progress,
          phase: "scanning",
          percent: Math.max(1, basePercent),
          currentStudy: study.study_label,
          detail,
        };
      });
      analyses.push({ ...analyzed, series: study });
      job.progress = {
        phase: "scanning",
        percent: Math.round(((index + 1) / selected.length) * 72),
        currentStudy: study.study_label,
        completedStudies: index + 1,
        totalStudies: selected.length,
        detail:
          analyzed.cacheStatus === "hit"
            ? `Cached analysis used for ${study.study_label}`
            : `Analysis complete for ${study.study_label}`,
      };
    }

    job.progress = {
      phase: "matching",
      percent: 82,
      completedStudies: selected.length,
      totalStudies: selected.length,
      detail: "Matching findings across dates",
    };
    const selectedStudyIds = selected.map((s) => s.study_id);
    const groups = buildComparisonGroups(
      analyses.map((a) => a.analysis),
      selectedStudyIds,
      group.modality,
    );

    job.progress = {
      phase: "summarizing",
      percent: 92,
      completedStudies: selected.length,
      totalStudies: selected.length,
      detail: "Preparing visible-change report",
    };
    const resultBase = {
      resultId: job.jobId,
      schemaVersion: PROGRESSION_COMPARE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      provider: job.provider,
      seriesGroup: {
        groupKey: group.group_key,
        label: group.label,
        modality: group.modality,
        seriesDescription: group.series_description,
      },
      studies: analyses.map((entry) => ({
        studyId: entry.analysis.studyId,
        studyLabel: entry.analysis.studyLabel,
        studyDate: entry.analysis.studyDate,
        seriesId: entry.analysis.seriesId,
        seriesKey: `${entry.analysis.studyId}:${entry.analysis.seriesId}`,
        totalSlices: entry.analysis.totalSlices,
        findingCount: entry.analysis.findings.length,
        cacheStatus: entry.cacheStatus,
      })),
      groups,
      limitations: comparisonLimitations(),
    };
    const result: ProgressionCompareResult = {
      ...resultBase,
      text: buildComparisonReport(resultBase),
      disclaimer: SAFETY_DISCLAIMER,
    };
    progressionCompareResults.set(result.resultId, result);
    await writeProgressionResult(result);

    job.status = "completed";
    job.resultId = result.resultId;
    job.completedAt = new Date().toISOString();
    job.progress = {
      phase: "completed",
      percent: 100,
      completedStudies: selected.length,
      totalStudies: selected.length,
      detail: "Whole-scan comparison complete",
    };
  } catch (err) {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.error = err instanceof Error ? err.message : String(err);
    job.progress = {
      ...job.progress,
      phase: "failed",
      detail: job.error,
    };
  }
}

app.post("/api/progression/compare/start", async (req: Request, res: Response) => {
  const parsed = ProgressionCompareStartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  try {
    const loaded = await loadAllStudies();
    const group = buildMatchedSeriesGroups(loaded).find((g) => g.group_key === parsed.data.groupKey);
    if (!group) return res.status(404).json({ error: "series_group_not_found" });
    const availableStudyIds = new Set(group.studies.map((s) => s.study_id));
    const studyIds = parsed.data.studyIds.filter((id) => availableStudyIds.has(id));
    if (new Set(studyIds).size < 2) {
      return res.status(400).json({ error: "need_at_least_two_studies" });
    }
    const job: ProgressionCompareJob = {
      jobId: randomUUID(),
      status: "queued",
      provider: parsed.data.provider,
      groupKey: parsed.data.groupKey,
      studyIds,
      progress: {
        phase: "queued",
        percent: 0,
        detail: "Queued",
        totalStudies: studyIds.length,
        completedStudies: 0,
      },
    };
    progressionCompareJobs.set(job.jobId, job);
    void runProgressionCompareJob(job);
    res.status(202).json({ jobId: job.jobId });
  } catch (err) {
    console.error("[/api/progression/compare/start]", err);
    res.status(500).json({ error: "progression_compare_start_failed" });
  }
});

app.get("/api/progression/compare/history", async (req: Request, res: Response) => {
  const parsed = ProgressionCompareHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  try {
    const reports = await listProgressionHistory(parsed.data.groupKey);
    res.json({ reports });
  } catch (err) {
    console.error("[/api/progression/compare/history]", err);
    res.status(500).json({ error: "progression_compare_history_failed" });
  }
});

app.get("/api/progression/compare/jobs/:jobId", (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  if (!SERIES_ID_RE.test(jobId)) return res.status(404).json({ error: "job_not_found" });
  const job = progressionCompareJobs.get(jobId);
  if (!job) return res.status(404).json({ error: "job_not_found" });
  res.json(job);
});

app.get("/api/progression/compare/results/:resultId", async (req: Request, res: Response) => {
  const resultId = Array.isArray(req.params.resultId) ? req.params.resultId[0] : req.params.resultId;
  if (!SERIES_ID_RE.test(resultId)) return res.status(404).json({ error: "result_not_found" });
  const result = await readProgressionResult(resultId);
  if (!result) return res.status(404).json({ error: "result_not_found" });
  res.json(result);
});

app.get("/api/progression/compare/results/:resultId/markdown", async (req: Request, res: Response) => {
  const resultId = Array.isArray(req.params.resultId) ? req.params.resultId[0] : req.params.resultId;
  if (!SERIES_ID_RE.test(resultId)) return res.status(404).json({ error: "result_not_found" });
  try {
    const result = await readProgressionResult(resultId);
    if (!result) return res.status(404).json({ error: "result_not_found" });
    const reportPath = result.reportPath;
    if (!reportPath) return res.status(404).json({ error: "report_not_found" });
    const relativeReportPath = path.relative(DATA_DIR, reportPath);
    if (relativeReportPath.startsWith("..") || path.isAbsolute(relativeReportPath)) {
      return res.status(403).json({ error: "report_path_forbidden" });
    }
    const real = await safeResolveUnder(DATA_DIR, relativeReportPath);
    if (!real) return res.status(403).json({ error: "report_path_forbidden" });
    const markdown = await fs.readFile(real, "utf8");
    res.type("text/markdown").send(markdown);
  } catch {
    res.status(404).json({ error: "report_not_found" });
  }
});

app.delete("/api/progression/compare/results/:resultId", async (req: Request, res: Response) => {
  const resultId = Array.isArray(req.params.resultId) ? req.params.resultId[0] : req.params.resultId;
  if (!SERIES_ID_RE.test(resultId)) return res.status(404).json({ error: "result_not_found" });
  try {
    const deleted = await deleteProgressionResult(resultId);
    if (!deleted) return res.status(404).json({ error: "result_not_found" });
    const reports = await listProgressionHistory(deleted.seriesGroup.groupKey);
    res.json({ deleted: true, reports });
  } catch (err) {
    console.error("[/api/progression/compare/results/:resultId DELETE]", err);
    res.status(500).json({ error: "report_delete_failed" });
  }
});

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ---------- Three-pass scan (survey → zoom → deep) ----------
// The frontend orchestrates the three calls so the user sees per-phase progress.

async function loadSeriesMetaForScan(studyId: string, seriesId: string): Promise<{
  totalSlices: number;
  seriesDescription: string;
  modality: string;
  studyLabel: string;
} | null> {
  const metaReal = await safeResolveUnder(DATA_DIR, seriesRelPath(studyId, seriesId, "meta.json"));
  if (!metaReal) return null;
  try {
    const raw = JSON.parse(await fs.readFile(metaReal, "utf8")) as {
      n_slices?: number;
      series_description?: string;
      modality?: string;
      study_label?: string;
    };
    const total = Number(raw.n_slices ?? 0);
    if (total <= 0) return null;
    return {
      totalSlices: total,
      seriesDescription: String(raw.series_description ?? ""),
      modality: String(raw.modality ?? ""),
      studyLabel: String(raw.study_label ?? ""),
    };
  } catch {
    return null;
  }
}

const SurveySchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    studyId: StudyIdZ,
    seriesId: SeriesIdZ,
  })
  .strict();

app.post("/api/scan/survey", async (req: Request, res: Response) => {
  const parsed = SurveySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const meta = await loadSeriesMetaForScan(parsed.data.studyId, parsed.data.seriesId);
  if (!meta) return res.status(404).json({ error: "series_not_found" });
  try {
    const result = await runSurvey({
      provider: parsed.data.provider,
      studyId: parsed.data.studyId,
      seriesId: parsed.data.seriesId,
      seriesDescription: meta.seriesDescription,
      modality: meta.modality,
      totalSlices: meta.totalSlices,
      dataDir: DATA_DIR,
    });
    res.json({
      text: result.text,
      rois: result.rois,
      sampledIndices: result.sampledIndices,
      fallback: result.fallback ?? false,
      provider: parsed.data.provider,
      disclaimer: SAFETY_DISCLAIMER,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; provider?: string };
    if (e?.code === "PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: "provider_not_configured", provider: e.provider });
    }
    console.error("[/api/scan/survey]", err);
    res.status(502).json({ error: "survey_failed" });
  }
});

const ROIInputZ = z
  .object({
    region: z.string().max(120),
    centerSlice: z.number().int().min(0),
    spanStart: z.number().int().min(0),
    spanEnd: z.number().int().min(0),
    why: z.string().max(400),
    priority: z.number().int().min(1).max(3),
  })
  .strict();

const ZoomSchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    studyId: StudyIdZ,
    seriesId: SeriesIdZ,
    rois: z.array(ROIInputZ).min(1).max(12),
  })
  .strict();

app.post("/api/scan/zoom", async (req: Request, res: Response) => {
  const parsed = ZoomSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const meta = await loadSeriesMetaForScan(parsed.data.studyId, parsed.data.seriesId);
  if (!meta) return res.status(404).json({ error: "series_not_found" });
  try {
    const result = await runZoom(
      {
        provider: parsed.data.provider,
        studyId: parsed.data.studyId,
        seriesId: parsed.data.seriesId,
        seriesDescription: meta.seriesDescription,
        modality: meta.modality,
        totalSlices: meta.totalSlices,
        dataDir: DATA_DIR,
      },
      parsed.data.rois as ROI[],
    );
    res.json({
      text: result.text,
      findings: result.findings,
      inspectedIndices: result.inspectedIndices,
      fallback: result.fallback ?? false,
      provider: parsed.data.provider,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; provider?: string };
    if (e?.code === "PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: "provider_not_configured", provider: e.provider });
    }
    console.error("[/api/scan/zoom]", err);
    res.status(502).json({ error: "zoom_failed" });
  }
});

const DeepSchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    studyId: StudyIdZ,
    seriesId: SeriesIdZ,
    regions: z.array(ROIInputZ).min(1).max(5),
  })
  .strict();

app.post("/api/scan/deep", async (req: Request, res: Response) => {
  const parsed = DeepSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const meta = await loadSeriesMetaForScan(parsed.data.studyId, parsed.data.seriesId);
  if (!meta) return res.status(404).json({ error: "series_not_found" });
  try {
    const result = await runDeep(
      {
        provider: parsed.data.provider,
        studyId: parsed.data.studyId,
        seriesId: parsed.data.seriesId,
        seriesDescription: meta.seriesDescription,
        modality: meta.modality,
        totalSlices: meta.totalSlices,
        dataDir: DATA_DIR,
      },
      parsed.data.regions as ROI[],
    );
    res.json({
      text: result.text,
      findings: result.findings,
      inspectedIndices: result.inspectedIndices,
      fallback: result.fallback ?? false,
      provider: parsed.data.provider,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; provider?: string };
    if (e?.code === "PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: "provider_not_configured", provider: e.provider });
    }
    console.error("[/api/scan/deep]", err);
    res.status(502).json({ error: "deep_failed" });
  }
});

const ScanFindingInputZ = z
  .object({
    sliceIndex: z.number().int().min(0).max(10000),
    xNorm: z.number().min(0).max(1),
    yNorm: z.number().min(0).max(1),
    radiusNorm: z.number().min(0.005).max(0.5),
    region: z.string().max(200),
    observation: z.string().max(2000),
    possibleMeanings: z.array(z.string().max(800)).max(8).default([]),
    healthyComparison: z.string().max(1200).default(""),
    questionsForOncologist: z.array(z.string().max(600)).max(8).default([]),
    confidence: z.number().min(0).max(1),
    severity: z.enum(["notable", "worth-asking", "clearly-physiologic"]),
  })
  .strict();

const SliceIndexArrayZ = z.array(z.number().int().min(0).max(10000)).max(10000).default([]);

const ScanReportPhaseZ = z
  .object({
    text: z.string().min(1).max(8000),
    findings: z.array(ScanFindingInputZ).max(60).default([]),
    inspectedIndices: SliceIndexArrayZ.optional(),
  })
  .strict();

const ScanReportSchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    studyId: StudyIdZ,
    seriesId: SeriesIdZ,
    survey: z
      .object({
        text: z.string().min(1).max(8000),
        rois: z.array(ROIInputZ).max(12),
        sampledIndices: SliceIndexArrayZ.optional(),
      })
      .strict(),
    zoom: ScanReportPhaseZ.optional(),
    deep: ScanReportPhaseZ.optional(),
  })
  .strict();

type ScanReportInput = z.infer<typeof ScanReportSchema>;

function sliceFilename(sliceIndex: number): string {
  return `slice_${String(sliceIndex).padStart(4, "0")}.png`;
}

function markdownLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\r/g, "")
    .trim();
}

function markdownBullets(items: string[] | undefined): string {
  if (!items || items.length === 0) return "- None listed.";
  return items.map((item) => `- ${markdownLine(item)}`).join("\n");
}

function imageMarkdownRef(studyId: string, seriesId: string, sliceIndex: number): {
  filename: string;
  relativePath: string;
  browserPath: string;
} {
  const filename = sliceFilename(sliceIndex);
  return {
    filename,
    relativePath: `../../${seriesId}/${filename}`,
    browserPath: `/data/${seriesRelPath(studyId, seriesId, filename).split(path.sep).join("/")}`,
  };
}

function indicesSummary(indices: number[] | undefined): string {
  if (!indices || indices.length === 0) return "None recorded.";
  const shown = indices.slice(0, 60).map((i) => i + 1).join(", ");
  return indices.length > 60 ? `${shown}, ... (${indices.length} total)` : shown;
}

function buildScanMarkdownReport(input: ScanReportInput, meta: Awaited<ReturnType<typeof loadSeriesMetaForScan>>, createdAt: string): string {
  const finalFindings = input.deep?.findings.length ? input.deep.findings : (input.zoom?.findings ?? []);
  const title = `${meta?.studyLabel || input.studyId} · ${meta?.seriesDescription || input.seriesId}`;
  const lines: string[] = [
    `# Lumen Scan Note`,
    "",
    `- Created: ${createdAt}`,
    `- Study: ${markdownLine(meta?.studyLabel || input.studyId)} (${input.studyId})`,
    `- Series: ${markdownLine(meta?.seriesDescription || input.seriesId)} (${input.seriesId})`,
    `- Modality: ${markdownLine(meta?.modality || "unknown")}`,
    `- Total images: ${meta?.totalSlices ?? "unknown"}`,
    `- AI model: ${input.provider}`,
    "",
    "## Purpose and limits",
    "",
    "This is an AI-generated education note from Lumen. It is meant to help recall what was reviewed, find referenced images again, and prepare questions for the oncology team. It is not a diagnosis, treatment decision, or official radiology report.",
    "",
    "## Scan context",
    "",
    `- Label: ${markdownLine(title)}`,
    `- Surveyed images: ${indicesSummary(input.survey.sampledIndices)}`,
    input.zoom ? `- Zoom-reviewed images: ${indicesSummary(input.zoom.inspectedIndices)}` : "- Zoom-reviewed images: not run",
    input.deep ? `- Deep-reviewed images: ${indicesSummary(input.deep.inspectedIndices)}` : "- Deep-reviewed images: not run",
    "",
    "## Survey summary",
    "",
    markdownLine(input.survey.text),
    "",
    "### Regions selected for closer review",
    "",
  ];

  if (input.survey.rois.length === 0) {
    lines.push("No regions were selected for closer review by the survey pass.", "");
  } else {
    for (const roi of input.survey.rois) {
      lines.push(
        `- ${markdownLine(roi.region)}: images ${roi.spanStart + 1}-${roi.spanEnd + 1}, center image ${roi.centerSlice + 1}; priority ${roi.priority}. ${markdownLine(roi.why)}`,
      );
    }
    lines.push("");
  }

  if (input.zoom) {
    lines.push("## Zoom summary", "", markdownLine(input.zoom.text), "");
  }
  if (input.deep) {
    lines.push("## Deep review summary", "", markdownLine(input.deep.text), "");
  }

  lines.push("## Structured findings", "");
  if (finalFindings.length === 0) {
    lines.push("No structured findings were saved from this scan run.", "");
  } else {
    finalFindings
      .slice()
      .sort((a, b) => a.sliceIndex - b.sliceIndex)
      .forEach((finding, index) => {
        const ref = imageMarkdownRef(input.studyId, input.seriesId, finding.sliceIndex);
        lines.push(
          `### ${index + 1}. ${markdownLine(finding.region)}`,
          "",
          `- Image: ${finding.sliceIndex + 1} (zero-based slice ${finding.sliceIndex})`,
          `- Local image file: \`${ref.relativePath}\``,
          `- Browser image path: \`${ref.browserPath}\``,
          `- Normalized location: x=${finding.xNorm.toFixed(3)}, y=${finding.yNorm.toFixed(3)}, radius=${finding.radiusNorm.toFixed(3)}`,
          `- Severity label: ${finding.severity}`,
          `- AI confidence: ${(finding.confidence * 100).toFixed(0)}%`,
          "",
          `![${ref.filename}](${ref.relativePath})`,
          "",
          "#### What Lumen saw",
          "",
          markdownLine(finding.observation),
          "",
          "#### Possible meanings to ask about",
          "",
          markdownBullets(finding.possibleMeanings),
          "",
          "#### Healthy comparison",
          "",
          markdownLine(finding.healthyComparison) || "None listed.",
          "",
          "#### Ask the oncologist",
          "",
          markdownBullets(finding.questionsForOncologist),
          "",
        );
      });
  }

  lines.push(
    "## Follow-up use",
    "",
    "When you ask Lumen follow-up questions about this same scan type, the app will automatically include the latest saved scan note as context along with the visible image. Treat the note as memory and navigation help, not as medical truth.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

app.post("/api/scan/report", async (req: Request, res: Response) => {
  const parsed = ScanReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const meta = await loadSeriesMetaForScan(parsed.data.studyId, parsed.data.seriesId);
  if (!meta) return res.status(404).json({ error: "series_not_found" });
  try {
    const createdAt = new Date().toISOString();
    const reportId = `${createdAt.replace(/[:.]/g, "-")}-${parsed.data.seriesId}`;
    const dir = scanNotesDir(parsed.data.studyId);
    const reportPath = path.join(dir, `${reportId}.md`);
    const latestPath = path.join(dir, `latest-${parsed.data.seriesId}.md`);
    const markdown = buildScanMarkdownReport(parsed.data, meta, createdAt);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(reportPath, markdown, "utf8");
    await fs.writeFile(latestPath, markdown, "utf8");
    res.json({
      reportId,
      reportPath,
      latestPath,
      createdAt,
    });
  } catch (err) {
    console.error("[/api/scan/report]", err);
    res.status(500).json({ error: "report_write_failed" });
  }
});

// Marker for the legacy single-pass scan endpoint that's now superseded by the
// three-phase /api/scan/{survey,zoom,deep} flow above. Kept to satisfy any
// in-flight client during HMR; will be removed once the frontend migrates.
const LegacyScanSchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    studyId: StudyIdZ,
    seriesId: SeriesIdZ,
    samples: z.number().int().min(4).max(24).default(16),
  })
  .strict();

app.post("/api/scan", async (req: Request, res: Response) => {
  const parsed = LegacyScanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const meta = await loadSeriesMetaForScan(parsed.data.studyId, parsed.data.seriesId);
  if (!meta) return res.status(404).json({ error: "series_not_found" });
  try {
    // Single-pass = just run the survey and surface ROIs as flagged slices for compatibility.
    const survey = await runSurvey({
      provider: parsed.data.provider,
      studyId: parsed.data.studyId,
      seriesId: parsed.data.seriesId,
      seriesDescription: meta.seriesDescription,
      modality: meta.modality,
      totalSlices: meta.totalSlices,
      dataDir: DATA_DIR,
    });
    const annotations = survey.rois.map((r) => ({
      sliceIndex: r.centerSlice,
      xNorm: 0.5,
      yNorm: 0.5,
      radiusNorm: 0.1,
      label: r.region,
      confidence: r.priority === 1 ? 0.8 : r.priority === 2 ? 0.5 : 0.3,
    }));
    const result = {
      text: survey.text,
      annotations,
      provider: parsed.data.provider,
      fallback: survey.fallback ?? false,
      sampledIndices: survey.sampledIndices,
    };
    res.json({
      text: result.text,
      annotations: result.annotations,
      provider: result.provider,
      fallback: result.fallback ?? false,
      sampledIndices: result.sampledIndices,
      disclaimer: SAFETY_DISCLAIMER,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; provider?: string };
    if (e?.code === "PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: "provider_not_configured", provider: e.provider });
    }
    console.error(`[scan ${parsed.data.provider}]`, err);
    res.status(502).json({ error: "scan_failed", provider: parsed.data.provider });
  }
});

// API key management — loopback-only, never returns the key value itself.
app.get("/api/keys/status", (_req: Request, res: Response) => {
  res.json({ keys: readStatus() });
});

const KeysSchema = z
  .object({
    ANTHROPIC_API_KEY: z.string().max(500).optional(),
    OPENAI_API_KEY: z.string().max(500).optional(),
    GOOGLE_API_KEY: z.string().max(500).optional(),
  })
  .strict();

app.post("/api/keys", async (req: Request, res: Response) => {
  const parsed = KeysSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  // Validate every non-empty value matches the expected provider format.
  const issues: string[] = [];
  const updates: Partial<Record<ProviderKey, string>> = {};
  for (const k of PROVIDER_KEYS) {
    const v = parsed.data[k];
    if (v === undefined) continue;
    if (v === "") {
      updates[k] = ""; // explicit deletion
      continue;
    }
    if (!looksLikeValidKey(k, v)) {
      issues.push(k);
      continue;
    }
    updates[k] = v;
  }
  if (issues.length > 0) return res.status(400).json({ error: "invalid_key_format", keys: issues });

  try {
    await writeKeys(updates);
    res.json({ ok: true, keys: readStatus() });
  } catch (err) {
    console.error("[/api/keys]", err);
    res.status(500).json({ error: "key_write_failed" });
  }
});

// Catch-all error guard so nothing leaks to the default Express HTML page.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[unhandled]", err);
  if (!res.headersSent) res.status(500).json({ error: "internal_error" });
});

migrateLegacyStudyIfNeeded()
  .then(() => {
    app.listen(PORT, "127.0.0.1", () => {
      console.log(`Lumen server on http://127.0.0.1:${PORT} (loopback only)`);
      console.log(`Study library: ${DATA_DIR}`);
    });
  })
  .catch((err) => {
    console.error("[startup]", err);
    process.exit(1);
  });
