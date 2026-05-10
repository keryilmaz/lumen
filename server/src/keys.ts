/**
 * API key management for the local server.
 *
 * Keys live in a single .env file at the project root. The server reads them
 * on startup (via dotenv) and lets the user set/replace them via POST /api/keys
 * — which writes the file and reloads process.env in-place.
 *
 * Security posture: the server only listens on 127.0.0.1, so the .env file
 * is the only attack surface for the keys. We never echo the secret back to
 * any client; status endpoint reports only "configured: bool" and a masked
 * suffix (last 4 chars) for visual confirmation.
 */

import fs from "node:fs/promises";
import path from "node:path";

export type ProviderKey = "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY";

export const PROVIDER_KEYS: ProviderKey[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
];

/** Map env var → provider id used by the rest of the app. */
export const KEY_TO_PROVIDER: Record<ProviderKey, "claude" | "gpt5" | "gemini"> = {
  ANTHROPIC_API_KEY: "claude",
  OPENAI_API_KEY: "gpt5",
  GOOGLE_API_KEY: "gemini",
};

/** Resolve the project-root .env regardless of where the server was started from. */
export function envPath(): string {
  // Server runs from server/ via `npm run dev`. The project root is one level up.
  return path.resolve(process.cwd(), "..", ".env");
}

/** Loose validation — keys are opaque strings but should look key-shaped. */
const KEY_FORMATS: Record<ProviderKey, RegExp> = {
  ANTHROPIC_API_KEY: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  OPENAI_API_KEY: /^sk-[A-Za-z0-9_-]{20,}$/,
  GOOGLE_API_KEY: /^[A-Za-z0-9_-]{20,}$/,
};

export function looksLikeValidKey(name: ProviderKey, value: string): boolean {
  return KEY_FORMATS[name].test(value);
}

/** Status for each provider: whether configured + last 4 of the key for visual confirmation. */
export type KeyStatus = {
  configured: boolean;
  last4?: string;
};
export type KeysStatus = Record<ProviderKey, KeyStatus>;

export function readStatus(): KeysStatus {
  const out = {} as KeysStatus;
  for (const k of PROVIDER_KEYS) {
    const v = process.env[k];
    out[k] = v
      ? { configured: true, last4: v.length >= 4 ? v.slice(-4) : "****" }
      : { configured: false };
  }
  return out;
}

/** Read and parse the .env file into key/value pairs. Lines we don't recognize
 *  are preserved verbatim and re-emitted on write. */
type EnvLine =
  | { kind: "kv"; key: string; value: string; raw: string }
  | { kind: "raw"; raw: string };

async function loadEnvLines(): Promise<EnvLine[]> {
  const p = envPath();
  let text = "";
  try {
    text = await fs.readFile(p, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return text.split(/\r?\n/).map((raw): EnvLine => {
    if (!raw.trim() || raw.trim().startsWith("#")) return { kind: "raw", raw };
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return { kind: "raw", raw };
    let value = m[2];
    // Strip optional surrounding single or double quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return { kind: "kv", key: m[1], value, raw };
  });
}

/** Atomically rewrite .env with the given updates merged in, preserving
 *  unknown lines and comments. Empty string deletes a key. */
export async function writeKeys(updates: Partial<Record<ProviderKey, string>>): Promise<void> {
  const lines = await loadEnvLines();
  const remaining = new Set(Object.keys(updates));

  const rewritten: string[] = [];
  for (const line of lines) {
    if (line.kind === "raw") {
      rewritten.push(line.raw);
      continue;
    }
    if (line.key in updates) {
      const v = updates[line.key as ProviderKey];
      if (v && v.length > 0) rewritten.push(envLine(line.key, v));
      remaining.delete(line.key);
    } else {
      rewritten.push(line.raw);
    }
  }
  // Append any keys not previously present
  for (const k of remaining) {
    const v = updates[k as ProviderKey];
    if (v && v.length > 0) rewritten.push(envLine(k, v));
  }

  // Always end with a trailing newline
  let out = rewritten.join("\n");
  if (!out.endsWith("\n")) out += "\n";

  const p = envPath();
  const tmp = `${p}.tmp.${process.pid}`;
  await fs.writeFile(tmp, out, { mode: 0o600 });
  await fs.rename(tmp, p);
  // Tighten permissions on the final file (rename preserves tmp's mode but be explicit)
  await fs.chmod(p, 0o600).catch(() => {});

  // Apply updates to the live process so subsequent requests use the new keys
  for (const [k, v] of Object.entries(updates)) {
    if (typeof v === "string") {
      if (v.length === 0) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function envLine(key: string, value: string): string {
  // Quote with double quotes and escape inner double quotes + backslashes.
  // API keys don't contain these characters but we defend in depth.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}
