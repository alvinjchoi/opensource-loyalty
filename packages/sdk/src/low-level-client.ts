import {
  GeneratedLipClient,
  type GeneratedCallOptions,
  type GeneratedOperation,
  type GeneratedTransport
} from "./generated/client.js";

export type LipApiKeyProvider = string | (() => string | Promise<string>);

export interface LipOpenApiClientOptions {
  baseUrl: string;
  apiKey?: LipApiKeyProvider;
  fetch?: typeof globalThis.fetch;
}

export class LipOpenApiHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(`LIP OpenAPI request failed with HTTP ${status}`);
    this.name = "LipOpenApiHttpError";
  }
}

export class LipOpenApiResponseError extends Error {
  public constructor(
    public readonly status: number,
    public readonly responseText: string
  ) {
    super(`LIP OpenAPI response for HTTP ${status} is not valid JSON`);
    this.name = "LipOpenApiResponseError";
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LipOpenApiResponseError(response.status, text);
  }
}

export function createLipOpenApiClient(options: LipOpenApiClientOptions): GeneratedLipClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  const transport: GeneratedTransport = {
    async request<TRequest, TResponse>(
      operation: GeneratedOperation<TRequest, TResponse>,
      body: TRequest | undefined,
      callOptions?: GeneratedCallOptions
    ): Promise<TResponse> {
      const headers = new Headers({ accept: "application/json" });
      if (operation.authenticated) {
        if (options.apiKey === undefined) {
          throw new TypeError(`apiKey is required for ${operation.operationId}`);
        }
        const apiKey = typeof options.apiKey === "function"
          ? await options.apiKey()
          : options.apiKey;
        headers.set("authorization", `Bearer ${apiKey}`);
      }
      if (body !== undefined) headers.set("content-type", "application/json");
      const request: RequestInit = {
        method: operation.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {})
      };
      const response = await fetcher(`${baseUrl}${operation.path}`, request);
      const parsed = await responseBody(response);
      if (!response.ok) throw new LipOpenApiHttpError(response.status, parsed);
      return parsed as TResponse;
    }
  };
  return new GeneratedLipClient(transport);
}
