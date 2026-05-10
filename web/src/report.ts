/**
 * Export-to-report: takes the full chat history + annotations + series catalog
 * and returns a self-contained HTML string designed for printing to PDF before
 * an oncology visit.
 *
 * - Per-series sections with all findings (each with structured detail)
 * - User questions + AI replies inline with their slice context
 * - Consolidated "Questions to ask the oncologist" list at the end (the most
 *   useful page to walk into the appointment with)
 * - PHI-free: shows series IDs and scan dates, never patient name
 * - One HTML file, embedded styles, no external dependencies — print-friendly
 */

import type { Annotation, ChatTurn, Finding, SeriesMeta } from "./types";
import { friendlyName } from "./friendly";

type ReportInput = {
  series: SeriesMeta[];
  history: ChatTurn[];
  annotations: Annotation[];
  generatedAt: Date;
};

/** Group history turns into "scan blocks" per series so the report reads chronologically. */
type ScanBlock = {
  seriesId?: string;
  seriesTitle?: string;
  surveyText?: string;
  zoomText?: string;
  deepText?: string;
  findings: Finding[];
  /** Per-slice user→ai exchanges that belong to this block (rough heuristic: same series). */
  exchanges: { question: string; answer: string; sliceIndex?: number; provider?: string }[];
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBullets(items: string[]): string {
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
}

const SEVERITY_BADGE: Record<Finding["severity"], string> = {
  notable: "<span class=\"sev sev-notable\">notable</span>",
  "worth-asking": "<span class=\"sev sev-worth\">worth asking</span>",
  "clearly-physiologic": "<span class=\"sev sev-physiologic\">likely normal</span>",
};

function renderFinding(f: Finding): string {
  return `
<section class="finding">
  <header class="finding-head">
    <h3>${escapeHtml(f.region)}</h3>
    <div class="finding-meta">
      <span class="image-ref">image #${f.sliceIndex + 1}</span>
      ${SEVERITY_BADGE[f.severity]}
      <span class="conf">${(f.confidence * 100).toFixed(0)}% confidence · ${escapeHtml(f.provider)}</span>
    </div>
  </header>
  <div class="finding-body">
    <div class="block">
      <h4>What I see</h4>
      <p>${escapeHtml(f.observation)}</p>
    </div>
    <div class="block">
      <h4>What this pattern can mean</h4>
      ${renderBullets(f.possibleMeanings)}
    </div>
    <div class="block">
      <h4>In a healthy scan, this area usually</h4>
      <p>${escapeHtml(f.healthyComparison)}</p>
    </div>
    <div class="block ask">
      <h4>Ask the oncologist</h4>
      ${renderBullets(f.questionsForOncologist)}
    </div>
  </div>
</section>`;
}

function renderExchange(e: { question: string; answer: string; sliceIndex?: number; provider?: string }): string {
  return `
<section class="exchange">
  <div class="exchange-q"><strong>You asked${typeof e.sliceIndex === "number" ? ` (image #${e.sliceIndex + 1})` : ""}:</strong> ${escapeHtml(e.question)}</div>
  <div class="exchange-a"><strong>${escapeHtml(e.provider ?? "AI")}:</strong> ${escapeHtml(e.answer).replace(/\n/g, "<br>")}</div>
</section>`;
}

function renderScanBlock(block: ScanBlock): string {
  const findingsHtml = block.findings.length
    ? block.findings
        .slice()
        .sort((a, b) => a.sliceIndex - b.sliceIndex)
        .map(renderFinding)
        .join("")
    : `<p class="muted">No structured findings from this scan run.</p>`;

  const summaries: string[] = [];
  if (block.surveyText) summaries.push(`<p><strong>Survey:</strong> ${escapeHtml(block.surveyText)}</p>`);
  if (block.zoomText) summaries.push(`<p><strong>Zoom:</strong> ${escapeHtml(block.zoomText)}</p>`);
  if (block.deepText) summaries.push(`<p><strong>Deep dive:</strong> ${escapeHtml(block.deepText)}</p>`);

  const exchangesHtml = block.exchanges.length
    ? `<div class="exchanges"><h3>Specific questions you asked</h3>${block.exchanges.map(renderExchange).join("")}</div>`
    : "";

  return `
<section class="scan-block">
  <h2>${escapeHtml(block.seriesTitle ?? "Scan")}</h2>
  ${block.seriesId ? `<div class="series-id">Series: ${escapeHtml(block.seriesId)}</div>` : ""}
  ${summaries.length ? `<div class="scan-summary">${summaries.join("")}</div>` : ""}
  <div class="findings">${findingsHtml}</div>
  ${exchangesHtml}
</section>`;
}

/** Group the chat history into per-series scan blocks. */
function buildBlocks(input: ReportInput): ScanBlock[] {
  const seriesById = new Map(input.series.map((s) => [s.series_id, s]));
  const blocks: ScanBlock[] = [];
  let current: ScanBlock | null = null;

  // Heuristic: any scanPhase=survey starts a new block. Otherwise turns get
  // appended to the current block (or a fresh block if none exists yet).
  for (const t of input.history) {
    if (t.role === "assistant" && t.scanPhase) {
      if (t.scanPhase.phase === "survey") {
        // Look back in annotations for which series this scan was for. We don't
        // have a series_id on the turn; infer from the most recent finding's slice
        // that matches a series. Simpler: leave seriesId blank, name "Scan run".
        current = { findings: [], exchanges: [] };
        blocks.push(current);
        current.surveyText = t.content;
      } else {
        if (!current) {
          current = { findings: [], exchanges: [] };
          blocks.push(current);
        }
        if (t.scanPhase.phase === "zoom") current.zoomText = t.content;
        if (t.scanPhase.phase === "deep") current.deepText = t.content;
        if (t.scanPhase.findings) {
          // Replace if we already had zoom findings and this is deep (deep supersedes zoom)
          if (t.scanPhase.phase === "deep") current.findings = t.scanPhase.findings;
          else if (current.findings.length === 0) current.findings = t.scanPhase.findings;
        }
      }
    } else if (t.role === "user") {
      // Pair next assistant turn as the answer
      const idx = input.history.indexOf(t);
      const next = input.history[idx + 1];
      if (next?.role === "assistant" && !next.scanPhase) {
        if (!current) {
          current = { findings: [], exchanges: [] };
          blocks.push(current);
        }
        current.exchanges.push({
          question: t.content,
          answer: next.content,
          sliceIndex: t.sliceIndex,
          provider: next.provider,
        });
      }
    }
  }

  // Try to attach series titles by scanning annotations for each block:
  // pick the series whose slice count matches the highest finding sliceIndex.
  for (const b of blocks) {
    const maxSlice = b.findings.reduce((m, f) => Math.max(m, f.sliceIndex), 0);
    const candidate = input.series
      .slice()
      .sort((a, b) => a.n_slices - b.n_slices)
      .find((s) => s.n_slices > maxSlice);
    if (candidate) {
      b.seriesId = candidate.series_id;
      b.seriesTitle = friendlyName(candidate).title;
    } else {
      b.seriesTitle = "Scan run";
    }
    // Drop seriesById ref — TS hint to mark it used so the linter is happy
    void seriesById;
  }

  return blocks;
}

function consolidatedQuestions(blocks: ScanBlock[]): { region: string; questions: string[] }[] {
  const out: { region: string; questions: string[] }[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    for (const f of b.findings) {
      const key = `${f.region}|${b.seriesTitle ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        region: `${f.region}${b.seriesTitle ? ` — from ${b.seriesTitle}` : ""}`,
        questions: f.questionsForOncologist,
      });
    }
  }
  return out;
}

const STYLES = `
:root {
  --ink: #1a1a1a;
  --muted: #6b6b6b;
  --rule: #e1e1e1;
  --notable: #b91c1c;
  --worth: #b45309;
  --physiologic: #6b6b6b;
  --accent: #0e7490;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #f5f5f5; color: var(--ink); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.page { max-width: 800px; margin: 24px auto; padding: 40px 48px; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
.toolbar { max-width: 800px; margin: 24px auto 0; padding: 0 48px; display: flex; justify-content: space-between; align-items: center; }
.toolbar button { padding: 8px 16px; background: var(--accent); color: white; border: 0; border-radius: 6px; font-size: 13px; cursor: pointer; }
.toolbar button:hover { opacity: 0.9; }
.toolbar .gen { color: var(--muted); font-size: 12px; }
h1 { font-size: 26px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 19px; margin: 32px 0 6px; padding-bottom: 6px; border-bottom: 2px solid var(--ink); font-weight: 600; }
h3 { font-size: 15px; margin: 18px 0 4px; font-weight: 600; }
h4 { font-size: 11.5px; margin: 12px 0 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
p, li { margin: 4px 0; }
ul { margin: 4px 0 4px 20px; padding: 0; }
.subtitle { color: var(--muted); margin: 0 0 6px; font-size: 14px; }
.lede { padding: 14px 16px; background: #fef9c3; border-left: 4px solid #ca8a04; margin: 18px 0 24px; font-size: 13px; }
.scan-summary { background: #f9fafb; padding: 12px 16px; margin: 8px 0 16px; border-radius: 6px; font-size: 13px; }
.scan-summary p { margin: 4px 0; }
.series-id { color: var(--muted); font-size: 12px; font-family: ui-monospace, Menlo, monospace; margin-bottom: 8px; }
.finding { margin: 14px 0; padding: 14px 16px; border: 1px solid var(--rule); border-radius: 8px; page-break-inside: avoid; }
.finding-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.finding-head h3 { margin: 0; }
.finding-meta { display: flex; gap: 8px; align-items: center; font-size: 12px; flex-wrap: wrap; }
.image-ref { font-family: ui-monospace, Menlo, monospace; color: var(--muted); }
.sev { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.sev-notable { background: #fee2e2; color: var(--notable); }
.sev-worth { background: #fef3c7; color: var(--worth); }
.sev-physiologic { background: #f3f4f6; color: var(--physiologic); }
.conf { color: var(--muted); }
.block { margin: 10px 0; }
.block.ask { background: #ecfeff; padding: 10px 14px; border-radius: 6px; border-left: 3px solid var(--accent); }
.block.ask h4 { color: var(--accent); }
.exchanges { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--rule); }
.exchange { margin: 12px 0; padding: 10px 14px; background: #fafafa; border-radius: 6px; font-size: 13px; }
.exchange-q { color: var(--ink); margin-bottom: 6px; }
.exchange-a { color: var(--muted); }
.consolidated { margin-top: 32px; padding-top: 24px; border-top: 3px double var(--ink); }
.consolidated h2 { border-bottom: 0; padding-bottom: 0; }
.consolidated .region { margin: 18px 0; }
.consolidated .region-label { font-weight: 600; font-size: 14px; color: var(--accent); margin-bottom: 4px; }
.disclaimer { margin-top: 32px; padding: 14px 16px; background: #fef9c3; font-size: 12px; color: #713f12; }
.muted { color: var(--muted); font-style: italic; }
@media print {
  body { background: white; }
  .toolbar { display: none; }
  .page { box-shadow: none; margin: 0; padding: 0; max-width: none; }
  h2 { page-break-before: auto; }
  .finding, .scan-block { page-break-inside: avoid; }
  .consolidated { page-break-before: always; }
}
`;

export function generateReportHtml(input: ReportInput): string {
  const blocks = buildBlocks(input);
  const consolidated = consolidatedQuestions(blocks);
  const date = input.generatedAt.toISOString().slice(0, 10);
  const time = input.generatedAt.toTimeString().slice(0, 5);
  const totalFindings = blocks.reduce((n, b) => n + b.findings.length, 0);
  const totalExchanges = blocks.reduce((n, b) => n + b.exchanges.length, 0);

  const consolidatedHtml = consolidated.length
    ? `
<section class="consolidated">
  <h2>Questions to ask the oncologist</h2>
  <p class="subtitle">All questions across all findings, grouped by region. Bring this page to the visit.</p>
  ${consolidated
    .map(
      (g) => `
<div class="region">
  <div class="region-label">${escapeHtml(g.region)}</div>
  ${renderBullets(g.questions)}
</div>`,
    )
    .join("")}
</section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Lumen report — ${date}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="toolbar">
  <span class="gen">Generated ${date} ${time}</span>
  <button onclick="window.print()">Print / save as PDF</button>
</div>
<article class="page">
  <h1>Lumen report</h1>
  <p class="subtitle">Personal AI-assisted analysis of imaging study, prepared for the oncology visit on ${date}.</p>
  <p class="subtitle">${blocks.length} scan run${blocks.length === 1 ? "" : "s"} · ${totalFindings} structured finding${totalFindings === 1 ? "" : "s"} · ${totalExchanges} specific question${totalExchanges === 1 ? "" : "s"} asked</p>

  <div class="lede">
    <strong>Important.</strong> This report was generated by a large language model looking at PNG exports of imaging slices.
    It is <strong>not a diagnosis</strong>. Every observation is one of several possibilities; the actual interpretation is
    the radiologist's and oncologist's. Use this as a starting point for the conversation, not a substitute for it.
  </div>

  ${blocks.map(renderScanBlock).join("")}

  ${consolidatedHtml}

  <div class="disclaimer">
    Generated by Lumen, a personal tool. Not medical advice. The AI cannot read SUV values from PNG exports,
    cannot compare to prior scans it hasn't been shown, and may misidentify physiologic uptake. Confirm everything with
    the oncology team.
  </div>
</article>
</body>
</html>`;
}

/** Export the report. Always downloads as a standalone HTML file (works in
 *  any browser, no popup blockers in the way). Also tries to open in a new
 *  tab using a Blob URL — if the browser blocks it, the user still has the
 *  downloaded file. The downloaded file is a self-contained HTML page with
 *  a print button at the top. */
export function openReportWindow(input: ReportInput): void {
  const html = generateReportHtml(input);
  const date = input.generatedAt.toISOString().slice(0, 10);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);

  // Always trigger the download — reliable across browsers
  const a = document.createElement("a");
  a.href = url;
  a.download = `lumen-report-${date}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Also try to open the blob URL in a new tab so the user can view immediately.
  // If popup-blocked, the download alone is enough.
  window.open(url, "_blank");

  // Revoke after 60s to give the new tab time to load
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Backwards-compat: same as openReportWindow now. */
export const downloadReport = openReportWindow;
