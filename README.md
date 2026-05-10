# Lumen

> A personal tool for understanding medical imaging scans and preparing better questions for the doctor.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Made with TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Runs locally](https://img.shields.io/badge/Runs-locally-brightgreen.svg)](#privacy)

**Lumen is a local-only web app for viewing DICOM medical imaging (PET, CT, MRI) and getting AI-assisted observations to bring to your oncology, radiology, or specialist visits.** Bring your own API keys (Claude, GPT-5, Gemini); your scans never leave your machine except for the specific images you actively send to one provider for analysis.

> ⚠️ **Lumen is not a medical device. It does not diagnose.** Every observation is framed as one of multiple possibilities, with explicit comparison to what's typical and a list of specific questions for the actual care team. The AI hallucinates. Use it to prepare better questions, not to make medical decisions.

---

## Why this exists

Imaging studies (PET/CT, MRI, bone scans) are how cancer treatment is monitored. The data lives on a disc the clinic hands you and a written report you may not see for days. By the time you're in the appointment, you have minutes to ask the right questions about a study you barely understood.

Lumen is the tool I wished existed: load the disc, scroll through the slices, point at things, ask plain-language questions, get back **structured observations + multiple possible interpretations + comparisons to what's typical + the exact questions to walk into the appointment with.**

It is not a substitute for the radiologist. It is a way to be a more informed patient or family member.

---

## What it does

**Image viewer**
- Load DICOM-format imaging discs (PET, CT, MRI, ultrasound, mammography)
- Scroll slices with mouse wheel; click + drag to circle a region of interest
- Multi-series support — switch between PET, CT, fusion views with a tab click
- Friendly naming layer translates `PT · PET AC` → `Glucose scan` with a one-line explanation of what each modality shows

**AI assistant — three modes**
1. **Look-for-cancer-signs scan** — three-pass deep analysis: surveys 16 evenly-spaced slices, zooms into regions of interest, then examines every slice in the top regions
2. **Per-slice questions** — circle a region, ask "what is this?" and get a structured response
3. **Multi-provider** — Claude, GPT-5, or Gemini, switchable per question

**Structured findings — the actual product**
Each AI finding includes:
- **Anatomical region** in plain language
- **What it observes** in concrete visual terms
- **What this pattern can mean** — 3–5 possibilities, ordered most-to-least likely, including benign alternatives
- **What a healthy scan typically shows** in this region
- **Specific questions to ask the oncologist** about this finding
- Severity tag (notable / worth asking / likely physiologic) and confidence

**Export to PDF**
One-click export of all findings + your specific questions + a consolidated "questions for the appointment" page, ready to print or save as PDF.

---

## What it doesn't do

- **It is not a diagnosis.** Every observation lists multiple possibilities and routes the final call to your care team.
- **It cannot read SUV values from PNG exports.** Quantitative SUV requires the original DICOM and a calibrated viewer.
- **It cannot compare to prior scans** unless you load both into the same session.
- **It does not give prognosis** or treatment recommendations.
- **It does not store your data on a server.** No telemetry, no analytics, no cloud sync.
- **It is not HIPAA-certified, FDA-cleared, or CE-marked.** It's a personal-use tool. If you're a clinician, use a clinical-grade viewer.

---

## Quick start

**Prerequisites:** macOS or Linux. Node.js 20+, Python 3.10+, and at least one API key from Anthropic, OpenAI, or Google.

```bash
# 1. Clone
git clone https://github.com/<your-username>/lumen.git
cd lumen

# 2. Set up Python venv for DICOM extraction
python3 -m venv .venv
.venv/bin/pip install pydicom pillow numpy

# 3. Install Node deps
cd web && npm install
cd ../server && npm install
cd ..

# 4. Mount your DICOM disc (or copy a study folder)
# On macOS, inserting a DICOM CD usually mounts at /Volumes/<NAME>
# Inspect what's on the disc:
.venv/bin/python tools/python/inspect_disc.py "/Volumes/<NAME>"

# 5. Extract the series to PHI-scrubbed PNGs
.venv/bin/python tools/python/extract.py "/Volumes/<NAME>"
# Writes to ./data/<series>/*.png + meta.json

# 6. Add an API key via the in-app Settings (gear icon),
#    or copy .env.example to .env and edit
cp .env.example .env

# 7. Start both servers (in two terminals, or use concurrently)
cd server && npm run dev    # local API on :5174
cd web    && npm run dev    # Vite dev server on :5173

# 8. Open http://localhost:5173
```

---

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (Vite + React 19 + TypeScript + Tailwind v4)       │
│                                                             │
│  ┌──────────────────────┐    ┌──────────────────────────┐  │
│  │   Canvas viewer      │    │   Multi-provider chat    │  │
│  │   (mouse + scroll)   │    │   (Claude/GPT-5/Gemini)  │  │
│  └──────────┬───────────┘    └────────────┬─────────────┘  │
└─────────────┼──────────────────────────────┼────────────────┘
              │                              │
              │      Resizable SplitPane     │
              │                              │
              ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Local Express server (loopback only — 127.0.0.1:5174)      │
│                                                             │
│  • /api/study           — list extracted series             │
│  • /api/scan/{survey,zoom,deep}  — three-pass deep scan     │
│  • /api/ask             — single-slice question             │
│  • /api/keys            — add/remove API keys (writes .env) │
│  • /data/<series>/<png> — serves PNG slices to browser      │
│                                                             │
│  Validates with Zod; fails closed; never echoes raw model   │
│  output unless it matches the structured schema.            │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
        Anthropic / OpenAI / Google APIs
        (only the slices the user actively sends)
```

**The scan is the heart of the app.** A three-pass approach because medical imaging series can have hundreds of slices and a single API call cannot examine all of them carefully:

1. **Survey** — 16 evenly-spaced slices → identifies regions of interest with rough slice ranges
2. **Zoom** — ~8 dense slices around each ROI → produces structured findings, drops false positives
3. **Deep dive** — every slice in the top 3 regions → confirms or downgrades each finding

Total: ~2–5 minutes per series, ~$1–5 per scan in API costs (varies by provider tier).

---

## Privacy

Lumen is designed for local-only use:

- The Node server **binds to `127.0.0.1` only** — not exposed to your LAN.
- DICOM extraction **strips PHI tags** (patient name, MRN, accession number, institution name, DOB) before writing PNGs.
- The `data/` directory is **gitignored** — committed accidentally, it would be the repo's worst day.
- API keys live in a local `.env` file, also gitignored.
- No telemetry, no analytics, no cloud sync.
- The only outbound network calls are to whichever AI provider you've configured (Anthropic / OpenAI / Google), and only when you actively ask a question or run a scan.
- Each provider's data-retention policy is their own — verify if you're concerned (Anthropic does not train on API inputs by default; OpenAI and Google have configurable training opt-outs).

For US users analyzing their own family's imaging: **HIPAA does not apply to private individuals** (it binds covered entities — providers, insurers, clearinghouses). For EU users: GDPR has a "purely personal/household activity" exemption (Art. 2(2)(c)) that covers personal use.

---

## Tech stack

- **Web**: Vite + React 19 + TypeScript + Tailwind v4
- **Server**: Express + TypeScript + Zod (validation)
- **DICOM**: pydicom for parsing + extraction; Pillow + NumPy for PNG generation
- **Viewer**: HTML canvas with custom ResizeObserver-driven re-fit, image-pixel-coord drag for resize-invariant annotations
- **AI**: Anthropic SDK, OpenAI SDK, Google Generative AI SDK — three providers, structured output via tool-use / response-format / response-schema
- **Layout**: Custom SplitPane with localStorage persistence and keyboard a11y

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the basics.

This is a personal-use tool; please don't submit changes that turn it into a clinical-grade product without discussing first. The safety guardrails (multi-possibility framing, refused diagnosis, fallback responses) are load-bearing — please don't relax them.

---

## License

[MIT](LICENSE) — with an explicit "not a medical device" notice in the license text. Use it, fork it, modify it. Just don't market it as a diagnostic tool.

---

## Acknowledgments

Built with [Claude Code](https://claude.com/claude-code) and the [Codex CLI](https://github.com/openai/codex) as a pair-engineering setup. The three-pass scan architecture, the educational-but-non-diagnostic system prompt design, and the safety-first response handling all came out of multi-agent code reviews.
