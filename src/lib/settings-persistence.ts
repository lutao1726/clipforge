import fs from "fs";
import path from "path";
import { getDataDir } from "@/lib/paths";

/** The self-hosted app has one local profile, so provider credentials live beside the data directory. */
export interface PersistedProviderSetting {
  enabled: boolean;
  apiKey: string;
  baseUrl?: string;
}

export interface PersistedSettings {
  providers: Record<string, PersistedProviderSetting>;
  token?: string;
}

const SETTINGS_FILE = () => path.join(getDataDir(), "settings.json");

function isProviderSetting(value: unknown): value is PersistedProviderSetting {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.enabled === "boolean" && typeof v.apiKey === "string" && (v.baseUrl === undefined || typeof v.baseUrl === "string");
}

function sanitizeProviders(value: unknown): Record<string, PersistedProviderSetting> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, PersistedProviderSetting> = {};
  for (const [name, setting] of Object.entries(value as Record<string, unknown>)) {
    // Provider names are internal identifiers; reject path-like keys before they can be persisted.
    if (!/^[a-z0-9_-]+$/i.test(name) || !isProviderSetting(setting)) continue;
    result[name] = {
      enabled: setting.enabled,
      apiKey: setting.apiKey.slice(0, 4096),
      ...(setting.baseUrl ? { baseUrl: setting.baseUrl.slice(0, 2048) } : {}),
    };
  }
  return result;
}

export function readPersistedSettings(): PersistedSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), "utf8");
    const parsed = JSON.parse(raw) as { providers?: unknown; token?: unknown };
    return {
      providers: sanitizeProviders(parsed.providers),
      token: typeof parsed.token === "string" ? parsed.token : undefined,
    };
  } catch {
    return { providers: {} };
  }
}

export function writePersistedProviders(value: unknown, token?: string): Record<string, PersistedProviderSetting> {
  const providers = sanitizeProviders(value);
  const file = SETTINGS_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ providers, ...(token ? { token } : {}) }, null, 2), { encoding: "utf8", mode: 0o600 });
  return providers;
}
