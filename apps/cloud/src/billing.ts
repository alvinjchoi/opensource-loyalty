import type {
  CloudOrganization,
  CloudPlan,
  CloudSubscription
} from "./types.js";

export interface BillingCheckout {
  checkout_id: string;
  url: string;
  expires_at: string;
}

export interface BillingSubscriptionUpdate {
  provider_customer_id: string;
  provider_subscription_id: string;
  status: CloudSubscription["status"];
  current_period_start: string;
  current_period_end: string;
}

/**
 * Provider boundary for the commercial billing adapter. The open control
 * plane owns plans, entitlements, and metering; Stripe or another provider
 * owns payment collection and sends normalized subscription updates here.
 */
export interface CloudBillingProvider {
  createCheckout(input: {
    organization: CloudOrganization;
    plan: CloudPlan;
    return_url: string;
  }): Promise<BillingCheckout>;
  cancelSubscription(
    subscription: CloudSubscription
  ): Promise<BillingSubscriptionUpdate>;
}

export class UnconfiguredBillingProvider implements CloudBillingProvider {
  public async createCheckout(): Promise<never> {
    throw new Error("A Cloud billing provider has not been configured");
  }

  public async cancelSubscription(): Promise<never> {
    throw new Error("A Cloud billing provider has not been configured");
  }
}
