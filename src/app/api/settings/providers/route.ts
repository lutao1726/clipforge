import { NextResponse } from "next/server";
import { readPersistedSettings, writePersistedProviders } from "@/lib/settings-persistence";

export const runtime = "nodejs";

/** Read the self-hosted provider profile so a browser/origin change does not lose API keys. */
export async function GET(request: Request) {
  const settings = readPersistedSettings();
  const token = requestToken(request);
  if (!settings.token || !token || token !== settings.token) {
    return NextResponse.json({ error: "Settings token required" }, { status: 401 });
  }
  return NextResponse.json({ providers: settings.providers });
}

/** Persist provider credentials/configuration in the app data directory. */
export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("providers" in body)) {
    return NextResponse.json({ error: "providers is required" }, { status: 400 });
  }

  try {
    const current = readPersistedSettings();
    const token = requestToken(request);
    if (!token || (current.token && token !== current.token)) {
      return NextResponse.json({ error: "Settings token required" }, { status: 401 });
    }
    return NextResponse.json({ providers: writePersistedProviders((body as { providers: unknown }).providers, current.token || token) });
  } catch (error) {
    console.error("provider settings persistence failed:", error);
    return NextResponse.json({ error: "Unable to persist provider settings" }, { status: 500 });
  }
}

function requestToken(request: Request): string | null {
  return request.headers.get("x-clipforge-settings-token") || null;
}
