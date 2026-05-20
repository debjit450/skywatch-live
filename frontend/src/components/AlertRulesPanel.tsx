import { useEffect, useState } from "react";
import { ShieldAlert, Trash2, X } from "lucide-react";
import { fetchBackendJson, fetchBackendResponse } from "@/lib/backend-api";

interface AlertRule {
  id: number;
  name: string;
  type: "geofence" | "threshold" | "pattern";
  config: Record<string, unknown>;
  active: boolean;
  localOnly?: boolean;
}

const LOCAL_RULES_KEY = "skywatch_local_alert_rules";

function readLocalRules(): AlertRule[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOCAL_RULES_KEY) || "[]") as AlertRule[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalRules(rules: AlertRule[]) {
  window.localStorage.setItem(LOCAL_RULES_KEY, JSON.stringify(rules));
}

export default function AlertRulesPanel({ onClose }: { onClose: () => void }) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [name, setName] = useState("");
  const [field, setField] = useState("altitude");
  const [operator, setOperator] = useState("gt");
  const [value, setValue] = useState("10000");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const load = () => {
    void fetchBackendJson<{ rules?: AlertRule[] }>("/api/v1/alert-rules/")
      .then((payload) => {
        setRules(Array.isArray(payload.rules) ? payload.rules : []);
        setStatusMessage(null);
      })
      .catch(() => {
        setRules(readLocalRules());
        setStatusMessage("Backend rules API unavailable. Local rules are saved in this browser.");
      });
  };

  useEffect(load, []);

  const createThreshold = () => {
    const nextRule: Omit<AlertRule, "id"> = {
      name: name || `${field} ${operator} ${value}`,
      type: "threshold",
      config: { field, operator, value: Number(value), duration_seconds: 30 },
      active: true,
    };
    void fetchBackendJson<AlertRule>("/api/v1/alert-rules/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextRule),
    })
      .then(() => {
        setName("");
        load();
      })
      .catch(() => {
        const localRule: AlertRule = {
          ...nextRule,
          id: Date.now(),
          localOnly: true,
        };
        const localRules = [localRule, ...readLocalRules()];
        writeLocalRules(localRules);
        setRules(localRules);
        setName("");
        setStatusMessage(
          "Rule saved locally. Start the Django backend to evaluate rules server-side.",
        );
      });
  };

  const patchRule = (rule: AlertRule, partial: Partial<AlertRule>) => {
    if (rule.localOnly) {
      const localRules = readLocalRules().map((item) =>
        item.id === rule.id ? { ...item, ...partial } : item,
      );
      writeLocalRules(localRules);
      setRules(localRules);
      return;
    }

    void fetchBackendJson<AlertRule>(`/api/v1/alert-rules/${rule.id}/`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partial),
    }).then(load);
  };

  const deleteRule = (id: number) => {
    const current = rules.find((rule) => rule.id === id);
    if (current?.localOnly) {
      const localRules = readLocalRules().filter((rule) => rule.id !== id);
      writeLocalRules(localRules);
      setRules(localRules);
      return;
    }
    void fetchBackendResponse(`/api/v1/alert-rules/${id}/`, { method: "DELETE" }).then(load);
  };

  return (
    <section className="sw-alert-rules-panel" data-tour="alert-rules">
      <header>
        <div>
          <ShieldAlert />
          <strong>Alert Rules</strong>
        </div>
        <button type="button" onClick={onClose}>
          <X />
        </button>
      </header>
      <div className="sw-rule-form">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Rule name"
        />
        <select value={field} onChange={(event) => setField(event.target.value)}>
          <option value="altitude">Altitude</option>
          <option value="speed">Speed</option>
          <option value="vrate">Vertical rate</option>
        </select>
        <select value={operator} onChange={(event) => setOperator(event.target.value)}>
          <option value="gt">Greater than</option>
          <option value="lt">Less than</option>
        </select>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          inputMode="numeric"
        />
        <button type="button" onClick={createThreshold}>
          Create
        </button>
      </div>
      {statusMessage && <p className="sw-rule-status">{statusMessage}</p>}
      <ul className="sw-rule-list">
        {rules.map((rule) => (
          <li key={rule.id}>
            <label>
              <input
                type="checkbox"
                checked={rule.active}
                onChange={() => patchRule(rule, { active: !rule.active })}
              />
              <span>
                <strong>{rule.name}</strong>
                <small>{rule.localOnly ? `${rule.type} / local` : rule.type}</small>
              </span>
            </label>
            <button type="button" onClick={() => deleteRule(rule.id)}>
              <Trash2 />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
