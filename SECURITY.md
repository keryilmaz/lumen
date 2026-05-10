# Security Policy

## Scope

Lumen is a **local-only personal-use tool**. Its design assumptions:

- Runs on the user's own machine
- Server binds to `127.0.0.1` (loopback) only — not LAN-exposed
- Brings the user's own API keys; never proxies through any third party
- Does not store or transmit imaging data outside of explicit AI provider calls

## Reporting a vulnerability

If you find a security issue (especially anything that could leak PHI, expose API keys, or escape the loopback boundary), please **do not** open a public issue.

Instead, open a [private security advisory](https://github.com/keryilmaz/lumen/security/advisories/new) on this repo. I'll respond within a few days.

For non-urgent suggestions on hardening the security posture, a normal issue is fine.

## What is in scope

- Path traversal in the local server (`/data/...` and series-id routes)
- API-key handling (`server/src/keys.ts` writes to `.env` — file permissions, escaping, etc.)
- Prompt injection through DICOM metadata or chat history that bypasses the safety guardrails
- AI response handling that could surface unstructured model output to the user (the fail-closed pattern is load-bearing — bypassing it is a vuln)
- Anything that changes the loopback-only binding without explicit user opt-in

## What is out of scope

- Issues that require a malicious actor to already have local code execution on the user's machine
- "What if a user manually publishes their `.env`" — outside the threat model
- The AI providers' own data handling (verify with each provider — Anthropic, OpenAI, Google have their own security docs)
- Vulnerabilities in transitive npm/pip dependencies (please report upstream; we accept dependency-bump PRs gladly)
