import { randomUUID } from "node:crypto";
import type { IdentityReference } from "@loyalty-interchange/protocol";
import { runBaselineConformance, runDoctor, type DiagnosticReport } from "./diagnostics.js";

export interface CloudVerificationExpectations {
  programId?: string;
  expectMember?: { identity: IdentityReference; available: number };
  expectMembers?: number;
}
export interface MemberBalanceCheck { ok: boolean; expected: number; actual: number | null }
export interface MemberCountCheck { ok: boolean; expected: number; actual: number | null }
export interface CloudVerificationReport {
  doctor: DiagnosticReport;
  conformance: DiagnosticReport;
  knownMember?: MemberBalanceCheck;
  memberCount?: MemberCountCheck;
  ok: boolean;
}

function context(): unknown {
  return {
    protocol_version: "1.0",
    profile: "foodservice/1.0",
    request_id: randomUUID(),
    idempotency_key: randomUUID(),
    occurred_at: new Date().toISOString(),
    source: { system: "lip-cloud-verify" }
  };
}

async function lookupAvailable(
  connection: { baseUrl: string; apiKey: string },
  programId: string,
  identity: IdentityReference
): Promise<number | null> {
  const base = connection.baseUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/lip/v1/members/lookup`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ context: context(), program_id: programId, identity }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json()) as { balances?: Array<{ available?: number }> };
  const balance = body.balances?.[0];
  return typeof balance?.available === "number" ? balance.available : null;
}

async function snapshotMemberCount(
  connection: { baseUrl: string; apiKey: string }
): Promise<number | null> {
  const base = connection.baseUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${connection.apiKey}` },
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const snap = (await res.json()) as { members?: unknown };
  return Array.isArray(snap.members) ? snap.members.length : null;
}

export async function runCloudVerification(
  connection: { baseUrl: string; apiKey: string },
  expectations: CloudVerificationExpectations = {}
): Promise<CloudVerificationReport> {
  const doctor = await runDoctor(connection);
  const conformance = await runBaselineConformance(connection);

  let knownMember: MemberBalanceCheck | undefined;
  if (expectations.expectMember) {
    if (!expectations.programId) {
      throw new Error("programId is required to verify a known member");
    }
    const actual = await lookupAvailable(connection, expectations.programId, expectations.expectMember.identity);
    knownMember = { ok: actual === expectations.expectMember.available, expected: expectations.expectMember.available, actual };
  }

  let memberCount: MemberCountCheck | undefined;
  if (typeof expectations.expectMembers === "number") {
    const actual = await snapshotMemberCount(connection);
    memberCount = { ok: actual === expectations.expectMembers, expected: expectations.expectMembers, actual };
  }

  const ok = doctor.ok && conformance.ok &&
    (knownMember?.ok ?? true) && (memberCount?.ok ?? true);
  return { doctor, conformance, ...(knownMember ? { knownMember } : {}), ...(memberCount ? { memberCount } : {}), ok };
}
