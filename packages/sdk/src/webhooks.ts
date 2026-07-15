export type WebhookVerificationCode =
  | "invalid_header"
  | "invalid_signature"
  | "timestamp_out_of_tolerance";

export class LipWebhookVerificationError extends Error {
  public readonly code: WebhookVerificationCode;

  public constructor(code: WebhookVerificationCode, message: string) {
    super(message);
    this.name = "LipWebhookVerificationError";
    this.code = code;
  }
}

export interface WebhookSignature {
  timestamp: string;
  signature: string;
}

export interface VerifyWebhookOptions {
  payload: string | Uint8Array;
  secret: string | Uint8Array;
  timestamp: string;
  signature: string;
  toleranceSeconds?: number;
  now?: () => Date;
}

function bytes(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function digest(payload: string | Uint8Array, secret: string | Uint8Array, timestamp: string): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const body = bytes(payload);
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, signed));
}

function timestampSeconds(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new LipWebhookVerificationError("invalid_header", "webhook timestamp must be Unix seconds");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new LipWebhookVerificationError("invalid_header", "webhook timestamp is outside the safe integer range");
  }
  return parsed;
}

export async function signWebhook(
  payload: string | Uint8Array,
  secret: string | Uint8Array,
  timestamp = Math.floor(Date.now() / 1000)
): Promise<WebhookSignature> {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError("webhook timestamp must be nonnegative Unix seconds");
  }
  const timestampHeader = `${timestamp}`;
  const signature = base64Url(await digest(payload, secret, timestampHeader));
  return { timestamp: timestampHeader, signature: `v1=${signature}` };
}

export async function verifyWebhook(options: VerifyWebhookOptions): Promise<void> {
  const timestamp = timestampSeconds(options.timestamp);
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) {
    throw new RangeError("webhook tolerance must be a nonnegative integer");
  }
  const now = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    throw new LipWebhookVerificationError(
      "timestamp_out_of_tolerance",
      "webhook timestamp is outside the allowed tolerance"
    );
  }

  const candidates = options.signature
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => decodeBase64Url(part.slice(3)))
    .filter((candidate): candidate is Uint8Array => candidate !== undefined);
  if (candidates.length === 0) {
    throw new LipWebhookVerificationError("invalid_header", "webhook signature contains no valid v1 value");
  }

  const expected = await digest(options.payload, options.secret, options.timestamp);
  if (!candidates.some((candidate) => constantTimeEqual(candidate, expected))) {
    throw new LipWebhookVerificationError("invalid_signature", "webhook signature does not match the payload");
  }
}
