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
    label: "OpenAI (GPT-5.5)",
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
      className="ui-backdrop fixed inset-0 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="ui-modal-panel max-w-xl w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 ui-divider flex items-center justify-between" style={{ borderBottomWidth: 1 }}>
          <h2 className="ui-title">API keys</h2>
          <button onClick={onClose} className="ui-control ui-control-icon" aria-label="Close API keys">
            ×
          </button>
        </header>

        <div className="ui-caption px-5 py-3 ui-divider" style={{ borderBottomWidth: 1 }}>
          Keys are saved to <code style={{ color: "var(--text-2)" }}>.env</code>
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
                  <label className="ui-title">{label}</label>
                  {isConfigured && (
                    <div className="flex items-center gap-2">
                      <span className="ui-caption" style={{ color: "var(--highlight)" }}>
                        ✓ saved (…{cur?.last4})
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(key)}
                        className="ui-inline-action"
                      >
                        remove
                      </button>
                      {!showInput && (
                        <button
                          type="button"
                          onClick={() => setDrafts((d) => ({ ...d, [key]: "" }))}
                          className="ui-inline-action"
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
                      className="ui-field flex-1 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setReveal((r) => ({ ...r, [key]: !r[key] }))}
                      className="ui-control"
                      title={reveal[key] ? "hide" : "show"}
                    >
                      {reveal[key] ? "hide" : "show"}
                    </button>
                    {drafts[key] !== undefined && isConfigured && (
                      <button
                        type="button"
                        onClick={() => setDrafts((d) => { const n = { ...d }; delete n[key]; return n; })}
                        className="ui-control"
                      >
                        cancel
                      </button>
                    )}
                  </div>
                )}
                <div className="ui-caption">{help}</div>
              </div>
            );
          })}
        </div>

        {error && <div className="ui-alert ui-alert-error px-5 py-2">{error}</div>}

        <footer className="px-5 py-3 ui-divider flex items-center justify-end gap-2" style={{ borderTopWidth: 1 }}>
          <button onClick={onClose} className="ui-control">
            Close
          </button>
          <button
            onClick={save}
            disabled={busy || Object.keys(drafts).length === 0}
            className="ui-control ui-control-primary w-auto"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
