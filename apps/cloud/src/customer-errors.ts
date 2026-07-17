export class CustomerPlatformError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CustomerPlatformError";
  }
}

export class CustomerProviderUnavailableError extends Error {
  public constructor(message = "Customer identity provider is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "CustomerProviderUnavailableError";
  }
}
