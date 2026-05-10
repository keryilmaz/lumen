# Scan Companion — Plan

A personal web tool for understanding a family member's PET/CT scan (bone cancer, treatment response monitoring), with an AI assistant that can answer questions and point at regions.

**This is not a medical device. It is a tool to help a family member prepare better questions for the actual oncology team.** Every AI response is framed as "conversation-starter, not diagnosis."

---

## What's actually on the disc

Despite the misleading README, the DICOM headers say:

| Series | Modality | Slices | Description |
|---|---|---|---|
| SE00003 | CT | 299 | CT Standard (512×512 axial) |
| SE00004 | CT | 780 | CT Lung/Bone window |
| SE00005 | CT | 780 | CT Abdomen thin-slice |
| **SE00012** | **PT** | **299** | **PET AC (256×256) — the PET volume** |
| SE01200 | OT | 299 | Axial fusion reconstruction |
| SE01201 | OT | 171 | Coronal fusion reconstruction |
| SE01202 | OT | 92 | Axial reconstruction (likely MIP) |
| SE00999 | CT | 1 | Dose report |

Source: a PET/CT imaging disc (DICOM, IHE-PDI standard).

---

## Architecture

```
┌──────────────────────────── Browser (Vite + React + TS) ────────────────────────────┐
│                                                                                     │
│  ┌─────────────── Viewer pane (Cornerstone3D) ─────────┐  ┌─── Chat pane ───┐      │
│  │                                                      │  │                 │      │
│  │  PET/CT fusion · MIP · stack scroll · circle ROI    │  │  AI conversation│      │
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
                  │       - Anthropic SDK (claude-sonnet-4-6)      │
                  │       - OpenAI SDK (gpt-5)                     │
                  │       - Google Gemini SDK                      │
                  │    → returns: { text, annotations[] }          │
                  │                                                │
                  │  System prompt enforces:                       │
                  │    - never diagnose                            │
                  │    - quantify uncertainty                      │
                  │    - "ask your oncologist about X" suggestions │
                  │    - returns annotations as structured JSON    │
                  │                                                │
                  └────────────────────────────────────────────────┘

  Data flow on disk:
    /Volumes/Untitled UDF Volume → tools/python/extract.py → ./data/<series>/*.png
    PHI is stripped on extraction; only pixel data + non-identifying acquisition
    metadata persisted. The browser only ever sees the scrubbed local data dir.
```

### Why a local Node server (not direct browser → API)

1. **API keys** stay out of browser bundle.
2. **PHI scrub** runs server-side as a final guard before any outbound request.
3. **Multi-provider fan-out** is cleaner with a server-side router.

---

## Components

### 1. Data extraction (Python, one-time)
- `tools/python/inspect_disc.py` — already written; reports series structure.
- `tools/python/extract.py` — reads each series, applies PET-appropriate windowing for PT (raw counts → 8-bit display), CT windowing presets for CT (lung, bone, soft tissue), writes PNG + `meta.json` (slice index, instance UID, slice position, SUV scaling factors). **Strips PHI** (name, MRN, accession, institution, DOB) — only pixel + acquisition params survive.

### 2. Web viewer (`web/`)
- Vite + React + TypeScript + Tailwind.
- **Cornerstone3D** (`@cornerstonejs/core` + `@cornerstonejs/tools`).
- Uses Cornerstone3D's `dicom-image-loader`, but for MVP we load pre-extracted PNGs (faster, simpler, sidesteps DICOM-in-browser quirks for first version). DICOM-direct is a v2 upgrade.
- Tools enabled: `StackScrollMouseWheelTool`, `WindowLevelTool`, `ZoomTool`, `PanTool`, `CircleROITool`.
- Layout: viewer on left (with series picker tabs: PET, CT-bone, CT-abdomen, axial fusion), chat on right.

### 3. Chat & AI router (`server/`)
- Express server, port 5174.
- `POST /api/ask` — accepts current slice (base64 PNG), optional cropped ROI region, slice index, series description, prior conversation, and chosen provider.
- **Provider adapters:**
  - Anthropic: `@anthropic-ai/sdk`, model `claude-sonnet-4-6` (vision + tool use; structured output for annotations).
  - OpenAI: `openai` SDK, model `gpt-5`.
  - Google: `@google/generative-ai`, model `gemini-2.5-pro`.
- Each adapter returns `{ text: string, annotations: Annotation[] }` where `Annotation = { sliceIndex, xNorm, yNorm, radiusNorm, label, confidence }`.

### 4. AI safety pattern (the most important component)
The system prompt enforces:
1. **Never diagnose.** Every response that interprets imaging starts with: "I'm not a doctor. Here's what I see in this image — confirm everything with the oncology team."
2. **Quantify uncertainty.** "I think this looks like X" not "this is X." Confidence numbers on annotations (0–1).
3. **Always suggest a question for the real doctor.** Every response ends with `Ask the oncologist:` followed by 1–3 specific questions tied to what was just discussed.
4. **Refuse SUV estimation.** General vision models can't read SUV from a PNG; the prompt explicitly tells the model to say so when asked.
5. **Acknowledge known limits.** Generic vision models miss small lesions, can't compare to priors, and hallucinate anatomical names. The prompt names these failure modes so they propagate into responses.
6. **No prognosis. No treatment recommendations. No "good news / bad news."** Pure descriptive observation + question prompts.

### 5. Annotation flow
- **User → AI**: user draws a circle with `CircleROITool`. On "Ask", the viewer crops the ROI from the current slice, sends both the full slice + the crop region (with the circle drawn on the full slice) to the chosen provider.
- **AI → User**: provider returns `annotations[]` in normalized coords. Viewer programmatically calls `CircleROITool.addAnnotation()` with denormalized coords on the named slice. Each AI annotation is colored differently from user annotations and labeled with the model's confidence.

---

## Data flow (single ask)

```
User scrolls to PET slice 142, draws circle around a hot region, types:
"What is this bright spot?"
                │
                ▼
Viewer crops circle from slice 142 → roi.png
Viewer renders user's circle on slice 142 → annotated_slice.png
                │
                ▼
POST /api/ask {
  provider: "claude",
  sliceIndex: 142,
  series: "PET AC",
  slicePng: <annotated_slice.png base64>,
  roiPng: <roi.png base64>,
  question: "What is this bright spot?",
  history: [...]
}
                │
                ▼
Server PHI-scrubs (already scrubbed — defense in depth)
Server sends to Anthropic with system prompt + structured-output schema
                │
                ▼
Claude returns: {
  text: "I'm not a doctor. The bright region you've circled is in
         the upper-mid abdomen, suggesting it could be in the area of
         the liver or adjacent lymph nodes — but I can't tell from a
         single slice alone. Hot regions on FDG-PET indicate higher
         glucose uptake, which can mean active disease but also
         normal tissue (heart, brain, bladder, brown fat, inflammation).
         Confirm this with the oncology team.

         Ask the oncologist:
         - Is this region a known lesion or new compared to prior PETs?
         - What's the SUVmax here, and how does it compare to
           the prior scan?
         - Could uptake here be physiologic (normal) rather than disease?",
  annotations: [
    { sliceIndex: 142, xNorm: 0.51, yNorm: 0.42, radiusNorm: 0.05,
      label: "circled region", confidence: 0.6 }
  ]
}
                │
                ▼
Viewer renders the response in chat + adds Claude's circle to slice 142
```

---

## Privacy posture

- All extracted data lives in `~/Desktop/scan-companion/data/` — `.gitignore` excludes it absolutely.
- `tools/python/extract.py` strips DICOM PHI tags on the way out: `PatientName`, `PatientID`, `PatientBirthDate`, `AccessionNumber`, `InstitutionName`, `InstitutionAddress`, `ReferringPhysicianName`, `OperatorsName`, all UIDs except `SeriesInstanceUID`.
- The Node server runs only on `127.0.0.1` (no LAN exposure).
- Outbound requests go to Anthropic / OpenAI / Google APIs only; no telemetry, no analytics.
- Anthropic does not train on API inputs/outputs by default. OpenAI doesn't train on API inputs by default (since 2023). Google Gemini API: training opt-in is region/tier-dependent — verify per-key.
- HIPAA does not apply to a private individual analyzing a relative's data (HIPAA binds covered entities). GDPR has a "purely personal/household activity" exemption (Art. 2(2)(c)).
- The disc itself is not modified.

---

## Weekend MVP milestones

**Day 1 (today)**
- [x] Project scaffold + `.gitignore` for medical data
- [x] Python venv + pydicom inspector
- [x] PLAN.md (this document)
- [ ] DICOM → PNG extractor (PHI-scrubbed, with metadata sidecar)
- [ ] Vite + React + TS bootstrap
- [ ] First-cut viewer: pick a series, scroll slices, basic windowing

**Day 2**
- [ ] Cornerstone3D circle annotation tool wired up
- [ ] Local Express server with one provider working (Claude first)
- [ ] System prompt + structured output schema for annotations
- [ ] AI annotation rendering on the viewer

**Day 3 (polish)**
- [ ] Add GPT-5 + Gemini providers
- [ ] Provider-pick UI in chat pane
- [ ] Conversation history per series
- [ ] Always-visible "this is not medical advice" banner
- [ ] README on how to run

---

## Out of scope for MVP (deferred)

- DICOM-direct loading in browser (use pre-extracted PNGs for v1)
- True PET/CT fusion view (the OT series already has fusion reconstructions; we display those separately first)
- True MIP rendering (SE01202 is likely already a MIP — display it as-is in v1)
- Cross-study comparison (need a second study; we have one)
- Persistent annotation save/load (in-memory per session is fine for MVP)
- Anonymized export to share with the oncologist
- Turkish UI (later — but we should display Turkish series descriptions correctly)

---

## Honest limits to keep in mind

1. **No vision model is trained on PET specifically.** Claude/GPT-5/Gemini will identify gross anatomy and obviously-bright regions, but cannot read SUV, cannot stage lymph nodes, cannot compare to a prior scan it hasn't seen. They will hallucinate confidently if not constrained.
2. **A single axial slice is not how PET is read.** Real radiologists scroll the volume, look at MIPs, fuse with CT, and compare to priors. Our tool gives a starting point for asking the actual radiologist better questions.
3. **AI annotations are pointers, not findings.** When the AI draws a circle, it means "I'd like to talk about this region," not "there is a lesion here."
4. **The most useful thing we can add later isn't more AI — it's the radiology report PDF.** The radiologist's written report is gold. If/when we get one, ingesting it as context for the chat will outperform any image analysis.
