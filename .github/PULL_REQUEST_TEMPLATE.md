<!-- Thanks for the PR. Please fill out the sections below before requesting review. -->

## What changes
A 2–3 sentence summary of what this PR does and why.

## How to test
Steps a reviewer can run to verify the change.

```bash
# example
cd web && npm run build
cd ../server && npx tsc --noEmit
```

## Safety checklist (medical-adjacent code)

- [ ] Does NOT relax any of the system-prompt safety rules (no diagnosis, multi-possibility framing, refuse SUV-from-PNG, etc.)
- [ ] Does NOT bypass fail-closed AI response parsing (no path that surfaces raw model text on schema failure)
- [ ] Does NOT introduce telemetry, analytics, or cloud sync
- [ ] Does NOT log PHI (patient names, MRN, etc.) anywhere
- [ ] Server still binds to `127.0.0.1` only
- [ ] `.gitignore` still excludes `data/`, `.env`, `.venv`

## Other checks

- [ ] Typechecks clean (`npx tsc --noEmit` in `web/` and `server/`)
- [ ] No new dependencies (or new dependency justified in description)
- [ ] No `/Users/` or other absolute personal paths in source

## Screenshots
For UI changes, attach before/after screenshots. **Redact any patient information.**
