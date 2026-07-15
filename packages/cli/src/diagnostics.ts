import {
  CapabilitiesDocumentSchema,
  WellKnownDocumentSchema,
  validate
} from "@loyalty-interchange/protocol";

export interface DiagnosticCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DiagnosticReport {
  ok: boolean;
  baseUrl: string;
  checks: DiagnosticCheck[];
}

export interface ConnectionOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

async function getJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  apiKey?: string
): Promise<{ response: Response; body: unknown }> {
  const response = await fetcher(url, {
    ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
    signal: AbortSignal.timeout(5000)
  });
  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch {
    body = undefined;
  }
  return { response, body };
}

export async function runDoctor(options: ConnectionOptions): Promise<DiagnosticReport> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const checks: DiagnosticCheck[] = [];

  try {
    const discovery = await getJson(fetcher, `${baseUrl}/.well-known/lip`);
    const valid = validate(WellKnownDocumentSchema, discovery.body);
    checks.push({
      name: "discovery",
      ok: discovery.response.status === 200 && valid.ok,
      detail: discovery.response.status === 200 && valid.ok
        ? "LIP 1.0 foodservice discovery is valid"
        : `expected valid discovery, received HTTP ${discovery.response.status}`
    });
  } catch (error: unknown) {
    checks.push({
      name: "discovery",
      ok: false,
      detail: error instanceof Error ? error.message : "request failed"
    });
  }

  try {
    const health = await getJson(fetcher, `${baseUrl}/health`);
    const healthy = health.response.status === 200 &&
      typeof health.body === "object" && health.body !== null &&
      (health.body as { status?: unknown }).status === "ok";
    checks.push({
      name: "health",
      ok: healthy,
      detail: healthy ? "server reports healthy" : `expected healthy response, received HTTP ${health.response.status}`
    });
  } catch (error: unknown) {
    checks.push({
      name: "health",
      ok: false,
      detail: error instanceof Error ? error.message : "request failed"
    });
  }

  try {
    const capabilities = await getJson(fetcher, `${baseUrl}/lip/v1/capabilities`, options.apiKey);
    const valid = validate(CapabilitiesDocumentSchema, capabilities.body);
    checks.push({
      name: "authentication and capabilities",
      ok: capabilities.response.status === 200 && valid.ok,
      detail: capabilities.response.status === 200 && valid.ok
        ? "Bearer authentication accepted; capabilities are valid"
        : `expected capabilities, received HTTP ${capabilities.response.status}`
    });
  } catch (error: unknown) {
    checks.push({
      name: "authentication and capabilities",
      ok: false,
      detail: error instanceof Error ? error.message : "request failed"
    });
  }

  return { ok: checks.every((check) => check.ok), baseUrl, checks };
}

export async function runBaselineConformance(options: ConnectionOptions): Promise<DiagnosticReport> {
  const report = await runDoctor(options);
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const endpoint = `${baseUrl}/lip/v1/members/enroll`;

  try {
    const unauthorized = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000)
    });
    const body = await unauthorized.json() as { code?: unknown };
    report.checks.push({
      name: "authentication rejection",
      ok: unauthorized.status === 401 && body.code === "unauthorized",
      detail: unauthorized.status === 401
        ? "unauthenticated mutation rejected"
        : `expected HTTP 401, received HTTP ${unauthorized.status}`
    });
  } catch (error: unknown) {
    report.checks.push({
      name: "authentication rejection",
      ok: false,
      detail: error instanceof Error ? error.message : "request failed"
    });
  }

  try {
    const invalid = await fetcher(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json"
      },
      body: "{}",
      signal: AbortSignal.timeout(5000)
    });
    const body = await invalid.json() as { code?: unknown };
    report.checks.push({
      name: "schema rejection",
      ok: invalid.status === 422 && body.code === "validation_failed",
      detail: invalid.status === 422
        ? "invalid payload rejected with problem details"
        : `expected HTTP 422, received HTTP ${invalid.status}`
    });
  } catch (error: unknown) {
    report.checks.push({
      name: "schema rejection",
      ok: false,
      detail: error instanceof Error ? error.message : "request failed"
    });
  }

  report.ok = report.checks.every((check) => check.ok);
  return report;
}

export function formatReport(report: DiagnosticReport): string {
  const lines = [
    report.ok ? "LIP diagnostics [pass]" : "LIP diagnostics [fail]",
    `Target: ${report.baseUrl}`,
    ""
  ];
  lines.push(...report.checks.map((check) =>
    `${check.ok ? "[pass]" : "[fail]"} ${check.name}: ${check.detail}`
  ));
  lines.push("", report.ok ? `PASS ${report.baseUrl}` : `FAIL ${report.baseUrl}`);
  return lines.join("\n");
}
