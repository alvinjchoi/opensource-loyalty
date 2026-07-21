import { describe, expect, it } from "vitest";
import { MemoryCloudRepository } from "./memory-repository.js";
import { CloudProvisioningWorker } from "./provisioning.js";
import { CloudControlPlane } from "./service.js";
import { startCloudServer } from "./server.js";
import {
  TenantOnboardingError,
  provisionTenant,
  rotateTenantCredentials
} from "./tenant-onboarding.js";

const apiKey = "cloud-onboarding-test-key";
const target = (url: string, overrides: Partial<{ apiKey: string; subject: string }> = {}) => ({
  cloudUrl: url,
  apiKey: overrides.apiKey ?? apiKey,
  subject: overrides.subject ?? "operator_biz_manager",
  email: "ops@example.com"
});

const request = (overrides: Partial<{ envSlug: string; programId: string }> = {}) => ({
  organization: { name: "Demo Restaurants", slug: "demo-restaurants" },
  project: { name: "Loyalty", slug: "loyalty" },
  environment: {
    name: "Production",
    slug: overrides.envSlug ?? "production",
    kind: "production" as const,
    region: "us-east-1",
    programId: overrides.programId ?? "demo-rewards"
  },
  poll: { timeoutMs: 1_500, intervalMs: 20 }
});

async function fixture() {
  const repository = new MemoryCloudRepository();
  const cloud = new CloudControlPlane({ repository, regions: ["us-east-1"] });
  const running = await startCloudServer(cloud, { apiKey, port: 0 });
  const worker = new CloudProvisioningWorker({
    repository,
    workerId: "onboarding-test-worker",
    provisioner: {
      provision: async ({ environment }) => ({
        api_url: `http://data-plane.internal:13210/${environment.tenant_id}`,
        admin_url: `http://data-plane.internal:13210/${environment.tenant_id}/admin/`
      })
    }
  });
  const drive = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await worker.runOnce() === "succeeded") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const close = async () => {
    worker.close();
    await running.close();
    await cloud.close();
  };
  return { url: running.url, drive, close };
}

describe("provisionTenant", () => {
  it("creates org, project, and environment, then reports the ready tenant", async () => {
    const { url, drive, close } = await fixture();
    try {
      const [result] = await Promise.all([
        provisionTenant(target(url), request()),
        drive()
      ]);
      expect(result.tenant_id).toMatch(/^tenant_/);
      expect(result.status).toBe("ready");
      expect(result.timed_out).toBe(false);
      expect(result.api_url).toContain(result.tenant_id);
      expect(result.created).toEqual({ organization: true, project: true, environment: true });
    } finally {
      await close();
    }
  });

  it("is idempotent: re-running with the same slugs reuses every resource", async () => {
    const { url, drive, close } = await fixture();
    try {
      const [first] = await Promise.all([
        provisionTenant(target(url), request()),
        drive()
      ]);
      const second = await provisionTenant(target(url), request());
      expect(second.tenant_id).toBe(first.tenant_id);
      expect(second.environment_id).toBe(first.environment_id);
      expect(second.status).toBe("ready");
      expect(second.created).toEqual({ organization: false, project: false, environment: false });
    } finally {
      await close();
    }
  });

  it("rejects reusing an environment slug for a different program", async () => {
    const { url, drive, close } = await fixture();
    try {
      await Promise.all([provisionTenant(target(url), request()), drive()]);
      await expect(
        provisionTenant(target(url), request({ programId: "other-program" }))
      ).rejects.toMatchObject({ code: "program_mismatch", status: 409 });
    } finally {
      await close();
    }
  });

  it("returns a pending, timed-out result when no provisioning worker runs", async () => {
    const { url, close } = await fixture();
    try {
      const result = await provisionTenant(target(url), {
        ...request(),
        poll: { timeoutMs: 100, intervalMs: 20 }
      });
      expect(result.status).toBe("pending");
      expect(result.timed_out).toBe(true);
      expect(result.api_url).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("surfaces control-plane authentication failures", async () => {
    const { url, close } = await fixture();
    try {
      await expect(
        provisionTenant(target(url, { apiKey: "wrong-key-wrong-key" }), request())
      ).rejects.toBeInstanceOf(TenantOnboardingError);
      await expect(
        provisionTenant(target(url, { apiKey: "wrong-key-wrong-key" }), request())
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      await close();
    }
  });
});

describe("rotateTenantCredentials", () => {
  it("returns the fresh merchant credential from the rotation endpoint", async () => {
    const repository = new MemoryCloudRepository();
    const cloud = new CloudControlPlane({ repository, regions: ["us-east-1"] });
    const running = await startCloudServer(cloud, {
      apiKey,
      port: 0,
      rotateEnvironmentCredentials: async (environmentId) => ({
        environment_id: environmentId,
        tenant_id: "tenant_rotated",
        program_id: "demo-rewards",
        api_url: "http://data-plane.internal:13999",
        admin_url: "http://data-plane.internal:13999/admin/",
        merchant_api_key: "lip_sk_rotated_merchant_secret",
        merchant_api_key_id: "key_rotated"
      })
    });
    const worker = new CloudProvisioningWorker({
      repository,
      workerId: "rotation-test-worker",
      provisioner: {
        provision: async ({ environment }) => ({
          api_url: `http://data-plane.internal:13210/${environment.tenant_id}`
        })
      }
    });
    try {
      const [provisioned] = await Promise.all([
        provisionTenant(target(running.url), request()),
        (async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (await worker.runOnce() === "succeeded") return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        })()
      ]);
      const rotated = await rotateTenantCredentials(
        target(running.url),
        provisioned.environment_id
      );
      expect(rotated).toMatchObject({
        environment_id: provisioned.environment_id,
        tenant_id: "tenant_rotated",
        merchant_api_key: "lip_sk_rotated_merchant_secret",
        merchant_api_key_id: "key_rotated",
        rotated_at: expect.any(String)
      });

      await expect(rotateTenantCredentials(target(running.url), "env_unknown"))
        .rejects.toMatchObject({ status: 404 });
    } finally {
      worker.close();
      await running.close();
      await cloud.close();
    }
  });
});
