import { describe, expect, it } from "vitest";
import { MemoryCloudRepository } from "./memory-repository.js";
import type { CloudEnvironment } from "./types.js";

function pendingEnv(): CloudEnvironment {
  return {
    environment_id: "env_1", project_id: "proj_1", slug: "prod", name: "Prod",
    kind: "production", region: "us-east-1", tenant_id: "tenant_1", program_id: "demo-rewards",
    status: "pending", created_at: "2026-07-18T00:00:00.000Z", updated_at: "2026-07-18T00:00:00.000Z"
  };
}

describe("attachEnvironment", () => {
  it("updates status, urls, and fingerprint; clears status_message on ready", async () => {
    const repo = new MemoryCloudRepository();
    await repo.createEnvironment(pendingEnv(), { /* audit */ } as never);
    const updated = await repo.attachEnvironment("env_1", {
      api_url: "https://lip.example.com", admin_url: "https://lip.example.com/admin/",
      api_key_fingerprint: "lip_sk_abcd…wxyz", status: "ready"
    });
    expect(updated).toMatchObject({
      status: "ready", api_url: "https://lip.example.com",
      admin_url: "https://lip.example.com/admin/", api_key_fingerprint: "lip_sk_abcd…wxyz"
    });
    expect(updated.status_message).toBeUndefined();
    // full key never stored
    expect(JSON.stringify(updated)).not.toContain("secret");
  });

  it("records failure status + message", async () => {
    const repo = new MemoryCloudRepository();
    await repo.createEnvironment(pendingEnv(), { /* audit */ } as never);
    const updated = await repo.attachEnvironment("env_1", {
      api_url: "https://lip.example.com", status: "failed", status_message: "auth_rejected"
    });
    expect(updated).toMatchObject({ status: "failed", status_message: "auth_rejected" });
  });

  it("clears the fingerprint on a failed re-attach (binding omits it)", async () => {
    const repo = new MemoryCloudRepository();
    await repo.createEnvironment(pendingEnv(), { /* audit */ } as never);
    await repo.attachEnvironment("env_1", {
      api_url: "https://lip.example.com", admin_url: "https://lip.example.com/admin/",
      api_key_fingerprint: "lip_sk_abcd…wxyz", status: "ready"
    });
    const failed = await repo.attachEnvironment("env_1", {
      api_url: "https://lip.example.com", status: "failed", status_message: "auth_rejected"
    });
    expect(failed.status).toBe("failed");
    expect(failed.api_key_fingerprint).toBeUndefined(); // cleared, matching Postgres
  });
});
