# Contributing to Lumen

Thanks for considering a contribution. A few things to know before you start.

## What this project is

Lumen is a **personal-use tool** for individuals (patients, family members) to look at their own medical imaging and prepare questions for healthcare appointments. It is not a clinical product, not a diagnostic tool, and not on a path to either.

Contributions that align with this purpose are welcome. Contributions that try to turn this into a clinical-grade product (FDA / CE / HIPAA-targeted) will be politely declined — that's a different project, deserves a different team, and would compromise the simplicity that makes Lumen useful for individuals.

## Ground rules

1. **Safety guardrails are load-bearing.** The system prompts that ban diagnostic language, the fallback responses for malformed AI output, the multi-possibility framing on every finding — all of this is intentional. Don't relax it without discussing.

2. **Keep PHI-free by default.** The DICOM extractor strips identifying tags. The data directory is gitignored. Server is loopback-only. If a PR introduces a new code path that handles imaging data, it must follow these patterns.

3. **Don't add cloud sync, telemetry, or analytics.** The product promise is "your data stays local." That's the whole point.

4. **Don't add new AI provider integrations without a structured-output strategy.** Every provider must validate output against the response schema and fail closed. See `server/src/scan.ts` for the existing pattern.

## How to set up a dev environment

See [README — Quick start](README.md#quick-start). Same flow.

For testing without a real DICOM disc, you can use any DICOM dataset from [The Cancer Imaging Archive](https://www.cancerimagingarchive.net/) or other public sources.

## What to work on

Current open areas (no roadmap, but these are areas where help would be welcome):

- **More modality support in the friendly-name layer** (`web/src/friendly.ts`) — MRI, ultrasound, SPECT, fluoroscopy
- **Local-only AI option** — currently requires a cloud API key. A local-LLM path (Ollama + a vision model) for users who want zero-network operation
- **Series comparison** — load two studies (e.g., this scan vs the prior scan) and let the AI compare. Currently you can only show the AI what's in front of it
- **Radiology report ingestion** — PDF or text upload of the actual radiology report, used as ground-truth context for the chat
- **Report export polish** — the current PDF export is functional but the typography could improve
- **Accessibility** — the canvas viewer needs keyboard nav and screen-reader support

## Pull request flow

1. Open an issue first for non-trivial changes — saves you from writing code that might not fit.
2. Fork, branch, code, test.
3. PR description should answer: what changes, why it matters, how you tested, any safety considerations.
4. Run `npm run build` in both `web/` and `server/` and confirm typechecks clean.
5. If you touched the AI prompts or response handling, include a brief note on what you ran the new flow against and what came out.

## Code style

- TypeScript strict mode
- Tailwind v4 for styling (use the design-token CSS variables in `web/src/index.css`, not hardcoded colors)
- No new dependencies without a clear justification — Lumen is intentionally small
- Keep comments to "why" not "what" — well-named code is the documentation

## Code of conduct

Be kind. This project sometimes attracts people in difficult situations (cancer diagnoses in the family). Discussions and PR reviews should reflect that.
