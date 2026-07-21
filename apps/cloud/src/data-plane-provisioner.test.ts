import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDataPlaneProvisioner, type ProvisionedRuntime } from "./data-plane-provisioner.js";
import { MemoryCloudRepository } from "./memory-repository.js";
import { CloudProvisioningWorker } from "./provisioning.js";
import { CloudControlPlane } from "./service.js";

const owner = {
  issuer: "https://identity.example.com",
  subject: "user_clerk_001",
  email: "owner@example.com"
};

function requestContext() {
  return {
    protocol_version: "1.0",
    profile: "foodservice/1.0",
    request_id: `req-${Math.random().toString(36).slice(2)}`,
    idempotency_key: `key-${Math.random().toString(36).slice(2)}`,
    occurred_at: new Date().toISOString(),
    source: { system: "cloud-provisioner-test" }
  };
}

const program = {
  program_id: "acme-rewards",
  name: "Acme Rewards",
  currency: "USD",
  accounts: [{ unit: "points", unit_label: "points", is_primary: true }],
  earn_rate: { points: 1, spend_minor_units: 100 },
  evaluation_ttl_seconds: 300,
  reservation_ttl_seconds: 300,
  rewards: [
    {
      reward_id: "five-off",
      name: "$5 off your order",
      points_cost: 50,
      effect: {
        type: "discount",
        target: "order",
        amount: { amount: 500, currency: "USD" },
        allocations: [{ amount: { amount: 500, currency: "USD" } }]
      },
      funding: [{ party_id: "acme-brand", party_type: "brand", share_bps: 10_000 }]
    }
  ]
};

async function fixture(input: { programId?: string } = {}) {
  const programDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-programs-"));
  const dataDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-data-"));
  writeFileSync(
    join(programDirectory, "acme-rewards.json"),
    JSON.stringify(program)
  );
  const provisioned: ProvisionedRuntime[] = [];
  const provisioner = new LocalDataPlaneProvisioner({
    programDirectory,
    dataDirectory,
    onProvisioned: (runtime) => provisioned.push(runtime)
  });
  const repository = new MemoryCloudRepository();
  const cloud = new CloudControlPlane({ repository });
  const dashboard = await cloud.createOrganization(owner, {
    name: "Acme Restaurants",
    slug: "acme-restaurants"
  });
  const project = await cloud.createProject(
    owner,
    dashboard.organization.organization_id,
    { name: "Acme Loyalty", slug: "acme-loyalty" }
  );
  const environment = await cloud.createEnvironment(owner, project.project_id, {
    name: "Staging",
    slug: "staging",
    kind: "staging",
    region: "us-east-1",
    program_id: input.programId ?? "acme-rewards"
  });
  const worker = new CloudProvisioningWorker({
    repository,
    provisioner,
    workerId: "worker-data-plane-test",
    onError: () => {}
  });
  return { provisioner, provisioned, repository, cloud, environment, worker };
}

describe("LocalDataPlaneProvisioner", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("provisions a reachable, authenticated LIP runtime for a pending environment", async () => {
    const { provisioner, provisioned, repository, environment, worker } = await fixture();
    close = () => provisioner.close();

    expect(environment.status).toBe("pending");
    expect(await worker.runOnce()).toBe("succeeded");

    const ready = await repository.environmentById(environment.environment_id);
    expect(ready).toMatchObject({ status: "ready" });
    expect(ready?.api_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    expect(provisioned).toHaveLength(1);
    const runtime = provisioned[0]!;
    expect(runtime.api_key).toMatch(/^lip_sk_/);

    const health = await fetch(`${ready!.api_url}/health`);
    expect(health.status).toBe(200);

    const authorized = await fetch(`${ready!.api_url}/lip/v1/programs/get`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.api_key}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ context: requestContext(), program_id: "acme-rewards" })
    });
    expect(authorized.status).toBe(200);
    const body = await authorized.json() as { program: { program_id: string } };
    expect(body.program.program_id).toBe("acme-rewards");

    const unauthorized = await fetch(`${ready!.api_url}/lip/v1/programs/get`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({ context: requestContext(), program_id: "acme-rewards" })
    });
    expect(unauthorized.status).toBe(401);

    // The advertised admin_url is backed by the full Admin service suite.
    const adminLocations = await fetch(`${ready!.api_url}/admin/api/v1/locations`, {
      headers: { authorization: `Bearer ${runtime.api_key}` }
    });
    expect(adminLocations.status).toBe(200);
    expect(await adminLocations.json()).toEqual({ locations: [] });
    const adminSnapshot = await fetch(`${ready!.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${runtime.api_key}` }
    });
    expect(adminSnapshot.status).toBe(200);
    expect(await adminSnapshot.json()).toMatchObject({
      program_management: expect.objectContaining({ active_program: expect.anything() }),
      access_control: expect.objectContaining({ tenant: expect.anything() })
    });

    // The credential is delivered as an operator-readable 0600 file.
    expect(statSync(runtime.credentials_path).mode & 0o777).toBe(0o600);

    // A retried job for an already-running environment reuses the runtime.
    expect(await provisioner.provision({
      environment: ready!,
      job: {
        provisioning_job_id: "job-retry",
        environment_id: environment.environment_id,
        operation: "create",
        status: "running",
        attempts: 2,
        available_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    })).toEqual({ api_url: runtime.api_url, admin_url: runtime.admin_url });
    expect(provisioner.runtimes()).toHaveLength(1);
  });

  it("fails provisioning when the program definition is missing", async () => {
    const { provisioner, repository, environment, worker } = await fixture({
      programId: "unknown-program"
    });
    close = () => provisioner.close();

    expect(await worker.runOnce()).toBe("retrying");
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({
      status: "pending",
      status_message: expect.stringContaining("unknown-program")
    });
    expect(provisioner.runtimes()).toHaveLength(0);
  });

  it("stops provisioned runtimes on close", async () => {
    const { provisioner, provisioned, repository, environment, worker } = await fixture();
    expect(await worker.runOnce()).toBe("succeeded");
    const ready = await repository.environmentById(environment.environment_id);

    await provisioner.close();
    expect(provisioner.runtimes()).toHaveLength(0);
    await expect(fetch(`${ready!.api_url}/health`)).rejects.toThrow();
    expect(provisioned).toHaveLength(1);
  });

  it("bootstraps a rotatable merchant key alongside the deprecated root key", async () => {
    const { provisioner, provisioned, repository, environment, worker } = await fixture();
    close = () => provisioner.close();
    expect(await worker.runOnce()).toBe("succeeded");
    const ready = await repository.environmentById(environment.environment_id);
    const runtime = provisioned[0]!;

    // The merchant credential is an owner-role access-control key, not the root key.
    expect(runtime.merchant_api_key).toMatch(/^lip_sk_/);
    expect(runtime.merchant_api_key).not.toBe(runtime.api_key);
    expect(runtime.merchant_api_key_id).toMatch(/^key_/);

    const credential = JSON.parse(readFileSync(runtime.credentials_path, "utf8")) as {
      version: number;
      api_key: string;
      api_key_deprecated: boolean;
      merchant_api_key: string;
      merchant_api_key_id: string;
    };
    expect(credential).toMatchObject({
      version: 2,
      api_key: runtime.api_key,
      api_key_deprecated: true,
      merchant_api_key: runtime.merchant_api_key,
      merchant_api_key_id: runtime.merchant_api_key_id
    });

    // The merchant key works on both surfaces of its own runtime.
    const protocol = await fetch(`${ready!.api_url}/lip/v1/programs/get`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.merchant_api_key}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ context: requestContext(), program_id: "acme-rewards" })
    });
    expect(protocol.status).toBe(200);
    const admin = await fetch(`${ready!.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${runtime.merchant_api_key}` }
    });
    expect(admin.status).toBe(200);
  });

  it("rotates merchant credentials in place with an overlap window", async () => {
    const { provisioner, provisioned, repository, environment, worker } = await fixture();
    close = () => provisioner.close();
    expect(await worker.runOnce()).toBe("succeeded");
    const ready = await repository.environmentById(environment.environment_id);
    const before = provisioned[0]!;

    const rotated = await provisioner.rotateCredentials(environment.environment_id);
    expect(rotated.merchant_api_key).toMatch(/^lip_sk_/);
    expect(rotated.merchant_api_key).not.toBe(before.merchant_api_key);
    expect(rotated.merchant_api_key_id).not.toBe(before.merchant_api_key_id);

    // File and in-memory runtime reflect the new credential.
    const credential = JSON.parse(readFileSync(before.credentials_path, "utf8")) as {
      merchant_api_key: string;
    };
    expect(credential.merchant_api_key).toBe(rotated.merchant_api_key);
    expect(provisioner.runtimes()[0]!.merchant_api_key).toBe(rotated.merchant_api_key);

    // Old and new merchant keys are both valid during the default overlap.
    for (const secret of [before.merchant_api_key, rotated.merchant_api_key]) {
      const probe = await fetch(`${ready!.api_url}/admin/api/v1/snapshot`, {
        headers: { authorization: `Bearer ${secret}` }
      });
      expect(probe.status).toBe(200);
    }

    await expect(provisioner.rotateCredentials("env_unknown"))
      .rejects.toThrowError(/env_unknown/);
  });

  it("does not seed tenant runtimes from host-level webhook env vars", async () => {
    process.env["LIP_WEBHOOK_URL"] = "https://host-level.example/hooks";
    process.env["LIP_WEBHOOK_SECRET"] = "host-level-shared-secret";
    try {
      const { provisioner, provisioned, repository, environment, worker } = await fixture();
      close = () => provisioner.close();
      expect(await worker.runOnce()).toBe("succeeded");
      const ready = await repository.environmentById(environment.environment_id);
      const health = await fetch(`${ready!.api_url}/admin/api/v1/webhooks/health`, {
        headers: { authorization: `Bearer ${provisioned[0]!.merchant_api_key}` }
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        enabled: false,
        subscription_count: 0
      });
    } finally {
      delete process.env["LIP_WEBHOOK_URL"];
      delete process.env["LIP_WEBHOOK_SECRET"];
    }
  });

  it("refuses to restore a credentials file carrying a weak root key", async () => {
    const programDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-programs-"));
    const dataDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-data-"));
    writeFileSync(join(programDirectory, "acme-rewards.json"), JSON.stringify(program));
    writeFileSync(join(dataDirectory, "env_weak.credentials.json"), JSON.stringify({
      environment_id: "env_weak",
      tenant_id: "tenant_weak",
      program_id: "acme-rewards",
      api_url: "http://127.0.0.1:19999",
      api_key: "lip-dev-key",
      port: 19_999
    }));
    const second = new LocalDataPlaneProvisioner({ programDirectory, dataDirectory });
    close = () => second.close();
    await expect(second.restore()).rejects.toThrowError(/lip-dev-key|16 characters|default/);
  });

  it("restores the same port and API key after close", async () => {
    const programDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-programs-"));
    const dataDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-data-"));
    writeFileSync(join(programDirectory, "acme-rewards.json"), JSON.stringify(program));
    const first = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      basePort: 18_210
    });
    const repository = new MemoryCloudRepository();
    const cloud = new CloudControlPlane({ repository });
    const dashboard = await cloud.createOrganization(owner, {
      name: "Acme Restaurants",
      slug: "acme-restaurants"
    });
    const project = await cloud.createProject(
      owner,
      dashboard.organization.organization_id,
      { name: "Acme Loyalty", slug: "acme-loyalty" }
    );
    const environment = await cloud.createEnvironment(owner, project.project_id, {
      name: "Staging",
      slug: "staging",
      kind: "staging",
      region: "us-east-1",
      program_id: "acme-rewards"
    });
    const worker = new CloudProvisioningWorker({
      repository,
      provisioner: first,
      workerId: "worker-restore",
      onError: () => {}
    });
    expect(await worker.runOnce()).toBe("succeeded");
    const original = first.runtimes()[0]!;
    await first.close();

    // Downgrade the credentials file to the v1 layout (root key only) to
    // prove restore keeps accepting legacy files and upgrades them in place.
    writeFileSync(original.credentials_path, JSON.stringify({
      environment_id: environment.environment_id,
      tenant_id: original.tenant_id,
      program_id: original.program_id,
      api_url: original.api_url,
      api_key: original.api_key,
      port: original.port
    }));

    const second = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      basePort: 18_210
    });
    close = () => second.close();
    const restored = await second.restore();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      environment_id: environment.environment_id,
      api_url: original.api_url,
      api_key: original.api_key,
      port: original.port
    });
    expect(await fetch(`${original.api_url}/health`).then((r) => r.status)).toBe(200);

    // The legacy file was upgraded to v2 with a freshly minted merchant key.
    const upgraded = JSON.parse(readFileSync(original.credentials_path, "utf8")) as {
      version: number;
      api_key: string;
      merchant_api_key: string;
    };
    expect(upgraded.version).toBe(2);
    expect(upgraded.api_key).toBe(original.api_key);
    expect(upgraded.merchant_api_key).toMatch(/^lip_sk_/);
    expect(await fetch(`${original.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${upgraded.merchant_api_key}` }
    }).then((r) => r.status)).toBe(200);
  });
});
