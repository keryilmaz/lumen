import { useEffect, useState } from "react";

type ProviderKeyName = "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY";
type KeyStatus = { configured: boolean; last4?: string };
type KeysStatus = Record<ProviderKeyName, KeyStatus>;

const FIELDS: { key: ProviderKeyName; label: string; provider: string; placeholder: string; help: string }[] = [
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic (Claude)",
    provider: "claude",
    placeholder: "sk-ant-…",
    help: "console.anthropic.com → API Keys",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI (GPT-5)",
    provider: "gpt5",
    placeholder: "sk-…",
    help: "platform.openai.com → API Keys",
  },
  {
    key: "GOOGLE_API_KEY",
    label: "Google (Gemini)",
    provider: "gemini",
    placeholder: "AIza…",
    help: "aistudio.google.com → Get API key",
  },
];

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: (status: KeysStatus) => void;
};

export function Settings({ open, onClose, onSaved }: Props) {
  const [status, setStatus] = useState<KeysStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDrafts({});
    fetch("/api/keys/status")
      .then((r) => r.json())
      .then((d) => setStatus(d.keys))
      .catch((e) => setError(`Could not load key status: ${e}`));
  }, [open]);

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const updates: Record<string, string> = {};
      for (const { key } of FIELDS) {
        if (drafts[key] !== undefined && drafts[key] !== "") {
          updates[key] = drafts[key].trim();
        }
      }
      if (Object.keys(updates).length === 0) {
        setError("Nothing to save — paste at least one key first.");
        setBusy(false);
        return;
      }
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "invalid_key_format") {
          setError(`That doesn't look like a valid key format: ${data.keys?.join(", ")}`);
        } else {
          setError(data.error ?? "Save failed");
        }
        setBusy(false);
        return;
      }
      setStatus(data.keys);
      setDrafts({});
      onSaved(data.keys);
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const remove = async (key: ProviderKeyName) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: "" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Remove failed");
        setBusy(false);
        return;
      }
      setStatus(data.keys);
      onSaved(data.keys);
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-neutral-950 border border-neutral-800 rounded-lg max-w-xl w-full shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-neutral-800 flex items-center justify-between">
          <h2 className="text-base font-medium">API keys</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 text-xl leading-none">
            ×
          </button>
        </header>

        <div className="px-5 py-3 text-xs text-neutral-400 border-b border-neutral-900">
          Keys are saved to <code className="text-neutral-300">.env</code>
          {" "}(local file, gitignored). They are sent only to each provider's API and never to anyone else.
          You only need one provider configured to use the app.
        </div>

        <div className="px-5 py-4 space-y-4">
          {FIELDS.map(({ key, label, placeholder, help }) => {
            const cur = status?.[key];
            const isConfigured = cur?.configured;
            const showInput = drafts[key] !== undefined || !isConfigured;
            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-neutral-200">{label}</label>
                  {isConfigured && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-emerald-400">
                        ✓ saved (…{cur?.last4})
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(key)}
                        className="text-xs text-neutral-500 hover:text-red-400"
                      >
                        remove
                      </button>
                      {!showInput && (
                        <button
                          type="button"
                          onClick={() => setDrafts((d) => ({ ...d, [key]: "" }))}
                          className="text-xs text-neutral-500 hover:text-cyan-400"
                        >
                          replace
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {showInput && (
                  <div className="flex gap-1">
                    <input
                      type={reveal[key] ? "text" : "password"}
                      value={drafts[key] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                      placeholder={placeholder}
                      autoComplete="off"
                      spellCheck={false}
                      className="flex-1 bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-cyan-700"
                    />
                    <button
                      type="button"
                      onClick={() => setReveal((r) => ({ ...r, [key]: !r[key] }))}
                      className="px-2 text-xs text-neutral-500 hover:text-neutral-300"
                      title={reveal[key] ? "hide" : "show"}
                    >
                      {reveal[key] ? "hide" : "show"}
                    </button>
                    {drafts[key] !== undefined && isConfigured && (
                      <button
                        type="button"
                        onClick={() => setDrafts((d) => { const n = { ...d }; delete n[key]; return n; })}
                        className="px-2 text-xs text-neutral-500 hover:text-neutral-300"
                      >
                        cancel
                      </button>
                    )}
                  </div>
                )}
                <div className="text-xs text-neutral-600">{help}</div>
              </div>
            );
          })}
        </div>

        {error && <div className="px-5 py-2 text-xs text-red-300 bg-red-950/40 border-t border-red-900">{error}</div>}

        <footer className="px-5 py-3 border-t border-neutral-800 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200">
            Close
          </button>
          <button
            onClick={save}
            disabled={busy || Object.keys(drafts).length === 0}
            className="px-3 py-1.5 text-sm bg-cyan-700 hover:bg-cyan-600 disabled:bg-neutral-800 disabled:text-neutral-600 rounded"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
