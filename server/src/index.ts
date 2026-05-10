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
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";
import { PROVIDERS, type Provider } from "./providers.js";
import { SAFETY_DISCLAIMER } from "./safety.js";
import {
  envPath,
  looksLikeValidKey,
  PROVIDER_KEYS,
  readStatus,
  writeKeys,
  type ProviderKey,
} from "./keys.js";
import { runSurvey, runZoom, runDeep, type ROI } from "./scan.js";

// Load .env from project root (one level up from server/). Override so that
// running `npm run dev` from server/ still picks up the canonical root .env.
dotenv.config({ path: envPath(), override: true });

const PORT = Number(process.env.PORT ?? 5174);
// Resolve DATA_DIR. If the env var is set and relative, treat it as project-root-relative
// (one level up from server/) — matches where users would think `./data` lives. Absolute
// paths pass through. Without an env var, default to the project-root data dir.
const DATA_DIR = (() => {
  const fromEnv = process.env.DATA_DIR;
  const projectRoot = path.resolve(process.cwd(), "..");
  if (!fromEnv) return path.join(projectRoot, "data");
  if (path.isAbsolute(fromEnv)) return fromEnv;
  return path.resolve(projectRoot, fromEnv);
})();

/** Strict series id — shared between routes that join it into a filesystem path. */
const SERIES_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SeriesIdZ = z.string().regex(SERIES_ID_RE, "invalid series_id");

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
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
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

// List available series + their meta
app.get("/api/study", async (_req: Request, res: Response) => {
  try {
    const studyReal = await safeResolveUnder(DATA_DIR, "study.json");
    if (!studyReal) return res.json({ series: [], disclaimer: SAFETY_DISCLAIMER });
    const studyRaw = await fs.readFile(studyReal, "utf8");
    const study = JSON.parse(studyRaw) as { series?: { series_id?: unknown }[] };
    const series = await Promise.all(
      (study.series ?? []).map(async (s) => {
        const id = String(s.series_id ?? "");
        if (!SERIES_ID_RE.test(id)) return null;
        const metaReal = await safeResolveUnder(DATA_DIR, path.join(id, "meta.json"));
        if (!metaReal) return null;
        try {
          return JSON.parse(await fs.readFile(metaReal, "utf8"));
        } catch {
          return null;
        }
      }),
    );
    res.json({ series: series.filter(Boolean), disclaimer: SAFETY_DISCLAIMER });
  } catch (err) {
    console.error("[/api/study]", err);
    res.status(500).json({ error: "study_load_failed" });
  }
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
    const result = await adapter(parsed.data);
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

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ---------- Three-pass scan (survey → zoom → deep) ----------
// The frontend orchestrates the three calls so the user sees per-phase progress.

async function loadSeriesMeta(seriesId: string): Promise<{
  totalSlices: number;
  seriesDescription: string;
  modality: string;
} | null> {
  const metaReal = await safeResolveUnder(DATA_DIR, path.join(seriesId, "meta.json"));
  if (!metaReal) return null;
  try {
    const raw = JSON.parse(await fs.readFile(metaReal, "utf8")) as {
      n_slices?: number;
      series_description?: string;
      modality?: string;
    };
    const total = Number(raw.n_slices ?? 0);
    if (total <= 0) return null;
    return {
      totalSlices: total,
      seriesDescription: String(raw.series_description ?? ""),
      modality: String(raw.modality ?? ""),
    };
  } catch {
    return null;
  }
}

const SurveySchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    seriesId: SeriesIdZ,
  })
  .strict();

app.post("/api/scan/survey", async (req: Request, res: Response) => {
  const parsed = SurveySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const meta = await loadSeriesMeta(parsed.data.seriesId);
  if (!meta) return res.status(404).json({ error: "series_not_found" });
  try {
    const result = await runSurvey({
      provider: parsed.data.provider,
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
    seriesId: SeriesIdZ,
    rois: z.array(ROIInputZ).min(1).max(12),
  })
  .strict();

app.post("/api/scan/zoom", async (req: Request, res: Response) => {
  const parsed = ZoomSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const meta = await loadSeriesMeta(parsed.data.seriesId);
  if (!meta) return res.status(404).json({ error: "series_not_found" });
  try {
    const result = await runZoom(
      {
        provider: parsed.data.provider,
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
    seriesId: SeriesIdZ,
    regions: z.array(ROIInputZ).min(1).max(5),
  })
  .strict();

app.post("/api/scan/deep", async (req: Request, res: Response) => {
  const parsed = DeepSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const meta = await loadSeriesMeta(parsed.data.seriesId);
  if (!meta) return res.status(404).json({ error: "series_not_found" });
  try {
    const result = await runDeep(
      {
        provider: parsed.data.provider,
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

// Marker for the legacy single-pass scan endpoint that's now superseded by the
// three-phase /api/scan/{survey,zoom,deep} flow above. Kept to satisfy any
// in-flight client during HMR; will be removed once the frontend migrates.
const LegacyScanSchema = z
  .object({
    provider: z.enum(["claude", "gpt5", "gemini"]),
    seriesId: SeriesIdZ,
    samples: z.number().int().min(4).max(24).default(16),
  })
  .strict();

app.post("/api/scan", async (req: Request, res: Response) => {
  const parsed = LegacyScanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const meta = await loadSeriesMeta(parsed.data.seriesId);
  if (!meta) return res.status(404).json({ error: "series_not_found" });
  try {
    // Single-pass = just run the survey and surface ROIs as flagged slices for compatibility.
    const survey = await runSurvey({
      provider: parsed.data.provider,
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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Lumen server on http://127.0.0.1:${PORT} (loopback only)`);
});
