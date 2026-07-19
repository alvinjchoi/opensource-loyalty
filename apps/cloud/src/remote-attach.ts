const EXPECTED_PROTOCOL = "1.0";
const EXPECTED_PROFILE = "foodservice/1.0";

export type AttachFailureCode =
  | "not_tls" | "health_unreachable" | "discovery_invalid"
  | "auth_rejected" | "auth_not_enforced" | "program_mismatch";

export interface AttachBinding {
  api_url: string;
  admin_url: string;
  api_key_fingerprint: string;
}
export type AttachResult =
  | { ok: true; binding: AttachBinding }
  | { ok: false; code: AttachFailureCode; message: string };

export interface RemoteEnvironmentAttacherOptions {
  fetch?: typeof globalThis.fetch;
}

export function apiKeyFingerprint(key: string): string {
  if (key.length <= 8) return "…";
  return `${key.slice(0, 11)}…${key.slice(-4)}`;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export class RemoteEnvironmentAttacher {
  private readonly fetchImpl: typeof globalThis.fetch;
  public constructor(options: RemoteEnvironmentAttacherOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async validate(input: {
    endpoint_url: string;
    api_key: string;
    program_id: string;
  }): Promise<AttachResult> {
    let base: URL;
    try {
      base = new URL(input.endpoint_url);
    } catch {
      return { ok: false, code: "health_unreachable", message: "endpoint_url is not a valid URL" };
    }
    if (base.protocol !== "https:" && !isLocalHost(base.hostname)) {
      return { ok: false, code: "not_tls", message: "endpoint_url must use https for a non-localhost host" };
    }
    const apiUrl = input.endpoint_url.replace(/\/+$/, "");
    const at = (p: string) => `${apiUrl}${p}`;

    // 1. health
    const health = await this.safe(() => this.fetchImpl(at("/health")));
    if (!health || !health.ok) return { ok: false, code: "health_unreachable", message: "GET /health did not return ok" };
    const healthBody = await this.json(health);
    if (!healthBody || (healthBody as { status?: unknown }).status !== "ok") {
      return { ok: false, code: "health_unreachable", message: "/health did not report status ok" };
    }

    // 2. discovery
    const disc = await this.safe(() => this.fetchImpl(at("/.well-known/lip")));
    const discBody = disc && disc.ok ? await this.json(disc) : undefined;
    const d = discBody as { protocol_version?: unknown; profile?: unknown } | undefined;
    if (!d || d.protocol_version !== EXPECTED_PROTOCOL || d.profile !== EXPECTED_PROFILE) {
      return { ok: false, code: "discovery_invalid", message: "discovery document missing or version mismatch" };
    }

    // 3. auth positive
    const authed = await this.safe(() => this.fetchImpl(at("/lip/v1/capabilities"), {
      headers: { authorization: `Bearer ${input.api_key}` }
    }));
    if (!authed || authed.status !== 200) return { ok: false, code: "auth_rejected", message: "api_key did not authenticate" };

    // 4. auth negative
    const bogus = `lip_sk_bogus_${Math.abs(hashString(input.api_key + apiUrl)).toString(36)}`;
    const denied = await this.safe(() => this.fetchImpl(at("/lip/v1/capabilities"), {
      headers: { authorization: `Bearer ${bogus}` }
    }));
    if (!denied || denied.status !== 401) return { ok: false, code: "auth_not_enforced", message: "host accepted an unknown key" };

    // 5. program match
    const prog = await this.safe(() => this.fetchImpl(at("/lip/v1/programs/get"), {
      method: "POST",
      headers: { authorization: `Bearer ${input.api_key}`, "content-type": "application/json" },
      body: JSON.stringify({ program_id: input.program_id })
    }));
    const progBody = prog && prog.ok ? await this.json(prog) : undefined;
    const servedId = (progBody as { program?: { program_id?: unknown } } | undefined)?.program?.program_id;
    if (servedId !== input.program_id) return { ok: false, code: "program_mismatch", message: "host serves a different program" };

    return {
      ok: true,
      binding: { api_url: apiUrl, admin_url: `${apiUrl}/admin/`, api_key_fingerprint: apiKeyFingerprint(input.api_key) }
    };
  }

  private async safe(run: () => Promise<Response>): Promise<Response | undefined> {
    try { return await run(); } catch { return undefined; }
  }
  private async json(res: Response): Promise<unknown> {
    try { return await res.json(); } catch { return undefined; }
  }
}

function hashString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) { h = (h << 5) - h + value.charCodeAt(i); h |= 0; }
  return h;
}
