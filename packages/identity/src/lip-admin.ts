/**
 * Cancels a LIP member via the reference Admin API so wallet writes fail while
 * ledger history is retained. Uses the same merchant/Admin bearer key as
 * protocol calls.
 */
export async function cancelLipMember(options: {
  baseUrl: string;
  apiKey: string;
  memberId: string;
  fetch?: typeof globalThis.fetch;
}): Promise<{ member_id: string; status: string }> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const response = await (options.fetch ?? globalThis.fetch)(
    `${baseUrl}/admin/api/v1/members/cancel`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ member_id: options.memberId })
    }
  );
  const payload = await response.json() as {
    member?: { member_id?: string; status?: string };
    detail?: string;
    title?: string;
  };
  if (!response.ok) {
    throw new Error(
      payload.detail ?? payload.title ?? `LIP member cancel failed (${response.status})`
    );
  }
  return {
    member_id: payload.member?.member_id ?? options.memberId,
    status: payload.member?.status ?? "closed"
  };
}
