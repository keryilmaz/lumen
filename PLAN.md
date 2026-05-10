# Lumen — Architecture Plan

A personal-use web tool for viewing DICOM medical imaging (PET, CT, MRI) and getting AI-assisted observations to bring to oncology, radiology, or specialist visits.

**This is not a medical device. It is a tool to help users prepare better questions for their actual care team.** Every AI response is framed as "conversation-starter, not diagnosis."

---

## Architecture

```
┌──────────────────────────── Browser (Vite + React + TS) ────────────────────────────┐
│                                                                                     │
│  ┌─────────────── Viewer pane (canvas) ────────────────┐  ┌─── Chat pane ───┐      │
│  │                                                      │  │                 │      │
│  │  Stack scroll · slice scrubber · circle ROI         │  │  AI conversation│      │
│  │                                                      │  │  Provider tabs: │      │
│  │  - User draws circle → emits ROI region              │  │  Claude · GPT-5 │      │
│  │  - AI returns coords → renders circle annotation     │  │  · Gemini       │      │
│  │  - Active slice + active ROI sent to AI on ask       │  │                 │      │
│  └──────────────────────────────────────────────────────┘  └─────────────────┘      │
│                                                                                     │
└──────────────────────────────────┬──────────────────────────────────────────────────┘
                                   │
                                   ▼
                  ┌──── Local Node server (Express, port 5174) ────┐
                  │                                                │
                  │  POST /api/ask                                 │
                  │    body: { provider, slicePng, roiPng?,        │
                  │            sliceIndex, question, history }     │
                  │    → fans out to:                              │
                  │       - Anthropic SDK                          │
                  │       - OpenAI SDK                             │
                  │       - Google Gemini SDK                      │
                  │    → returns: { text, annotations[] }          │
                  │                                                │
                  │  POST /api/scan/{survey,zoom,deep}             │
                  │    Three-pass deep scan (see below)            │
                  │                                                │
                  │  System prompt enforces:                       │
                  │    - never diagnose                            │
                  │    - quantify uncertainty                      │
                  │    - "ask your specialist about X" suggestions │
                  │    - returns annotations as structured JSON    │
                  │                                                │
                  └────────────────────────────────────────────────┘

  Data flow on disk:
    DICOM disc → tools/python/extract.py → ./data/<series>/*.png
    PHI is stripped on extraction; only pixel data + non-identifying acquisition
    metadata persisted. The browser only ever sees the scrubbed local data dir.
```

### Why a local Node server (not direct browser → API)

1. **API keys** stay out of browser bundle.
2. **PHI scrub** runs server-side as a final guard before any outbound request.
3. **Multi-provider fan-out** is cleaner with a server-side router.

---

## Components

### 1. Data extraction (Python, one-time per study)
- `tools/python/inspect_disc.py` — reports series structure of a mounted DICOM disc.
- `tools/python/extract.py` — reads each series, applies modality-appropriate windowing (CT lung/bone/soft-tissue presets, percentile clip for PET, raw rescale for fusion/OT), writes PNG + `meta.json` (slice index, instance UID, slice position, scaling factors). **Strips PHI** (name, MRN, accession, institution, DOB) — only pixel + acquisition params survive.

### 2. Web viewer (`web/`)
- Vite + React 19 + TypeScript + Tailwind v4.
- Custom canvas viewer: scroll/zoom, click-drag circle ROI, image-pixel-coord drag (resize-invariant).
- Loads pre-extracted PNGs (faster + simpler than DICOM-in-browser).
- Resizable SplitPane between viewer and chat (drag handle, localStorage persistence, keyboard a11y, collapse).
- Tools enabled via mouse + scrubber: stack scroll, click+drag circle ROI, slice navigation.
- Layout: viewer on left (with series picker tabs across modalities), chat on right.

### 3. Chat & AI router (`server/`)
- Express server, port 5174, **127.0.0.1 only** (no LAN exposure).
- `POST /api/ask` — single-slice question with optional ROI crop.
- `POST /api/scan/survey|zoom|deep` — three-pass deep scan endpoints.
- **Provider adapters:** Anthropic SDK, OpenAI SDK, Google Generative AI SDK.
- Each adapter returns `{ text, annotations[] }` validated against a strict Zod schema.
- Fail-closed: malformed AI responses trigger a safe fallback message — raw model text is never surfaced to the user without schema validation.

### 4. AI safety pattern (the most important component)
The system prompt enforces:
1. **Never diagnose.** Every response that interprets imaging starts with hedged framing.
2. **Quantify uncertainty.** "I think this looks like X" not "this is X." Confidence numbers on annotations (0–1).
3. **Always suggest a question for the real doctor.** Every response ends with `Ask the specialist:` followed by 1–3 specific questions tied to what was just discussed.
4. **Refuse SUV estimation.** General vision models can't read SUV from a PNG; the prompt explicitly tells the model to say so when asked.
5. **Acknowledge known limits.** Generic vision models miss small lesions, can't compare to priors, and can hallucinate anatomical names. The prompt names these failure modes so they propagate into responses.
6. **No prognosis. No treatment recommendations. No "good news / bad news."** Pure descriptive observation + question prompts.

### 5. Annotation flow
- **User → AI**: user draws a circle. On "Ask", the viewer crops the ROI from the current slice, sends both the full slice + the crop region to the chosen provider.
- **AI → User**: provider returns `annotations[]` in normalized coords. Viewer programmatically renders circles with the AI's confidence + label.

### 6. Three-pass deep scan
For studies with hundreds of slices, a single API call cannot examine all of them carefully. The scan endpoint orchestrates:

1. **Survey** — 16 evenly-spaced slices → identifies regions of interest with rough slice ranges.
2. **Zoom** — ~8 dense slices around each ROI → produces structured findings, drops false positives.
3. **Deep dive** — every slice in the top 3 regions → confirms or downgrades each finding.

Each finding includes: anatomical region, observation, possible interpretations (3–5), comparison to a healthy scan, specific questions for the care team, severity, and confidence.

### 7. Report export
One-click HTML export of all findings + user questions + a consolidated "questions for the appointment" page. Print-friendly stylesheet for PDF.

---

## Privacy posture

- All extracted data lives in the local `data/` directory — `.gitignore` excludes it absolutely.
- `tools/python/extract.py` strips DICOM PHI tags on the way out: `PatientName`, `PatientID`, `PatientBirthDate`, `AccessionNumber`, `InstitutionName`, `InstitutionAddress`, `ReferringPhysicianName`, `OperatorsName`, all UIDs except `SeriesInstanceUID`.
- The Node server runs only on `127.0.0.1` (no LAN exposure).
- Outbound requests go to the configured AI providers only; no telemetry, no analytics, no cloud sync.
- Default provider data-retention: Anthropic does not train on API inputs by default; OpenAI and Google have configurable training opt-outs — verify per provider.
- HIPAA does not apply to a private individual analyzing their own family's data (HIPAA binds covered entities). GDPR has a "purely personal/household activity" exemption (Art. 2(2)(c)).
- The DICOM disc itself is never modified.

---

## Honest limits

1. **No vision model is medical-imaging-specialized.** General frontier models (Claude, GPT, Gemini) will identify gross anatomy and obviously bright/dark regions, but cannot read SUV, stage anything, or compare to scans they haven't been shown. They will hallucinate confidently if not constrained.
2. **A single axial slice is not how imaging is read.** Real radiologists scroll the volume, look at MIPs, fuse modalities, and compare to priors. Lumen gives a starting point for asking the actual radiologist better questions.
3. **AI annotations are pointers, not findings.** When the AI draws a circle, it means "I'd like to talk about this region," not "there is a lesion here."
4. **The most useful thing to add later isn't more AI — it's the radiology report PDF.** The radiologist's written report is gold. If/when you upload one as context, the chat gets dramatically more useful.
