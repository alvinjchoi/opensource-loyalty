import { mkdtempSync, statSync, writeFileSync } from "node:fs";
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
  program_id: "sakura-rewards",
  name: "Sakura Rewards",
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
      funding: [{ party_id: "sakura-brand", party_type: "brand", share_bps: 10_000 }]
    }
  ]
};

async function fixture(input: { programId?: string } = {}) {
  const programDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-programs-"));
  const dataDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-data-"));
  writeFileSync(
    join(programDirectory, "sakura-rewards.json"),
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
    name: "Sakura Restaurants",
    slug: "sakura-restaurants"
  });
  const project = await cloud.createProject(
    owner,
    dashboard.organization.organization_id,
    { name: "Sakura Loyalty", slug: "sakura-loyalty" }
  );
  const environment = await cloud.createEnvironment(owner, project.project_id, {
    name: "Staging",
    slug: "staging",
    kind: "staging",
    region: "us-east-1",
    program_id: input.programId ?? "sakura-rewards"
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
      body: JSON.stringify({ context: requestContext(), program_id: "sakura-rewards" })
    });
    expect(authorized.status).toBe(200);
    const body = await authorized.json() as { program: { program_id: string } };
    expect(body.program.program_id).toBe("sakura-rewards");

    const unauthorized = await fetch(`${ready!.api_url}/lip/v1/programs/get`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({ context: requestContext(), program_id: "sakura-rewards" })
    });
    expect(unauthorized.status).toBe(401);

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

  it("restores the same port and API key after close", async () => {
    const programDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-programs-"));
    const dataDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-data-"));
    writeFileSync(join(programDirectory, "sakura-rewards.json"), JSON.stringify(program));
    const first = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      basePort: 18_210
    });
    const repository = new MemoryCloudRepository();
    const cloud = new CloudControlPlane({ repository });
    const dashboard = await cloud.createOrganization(owner, {
      name: "Sakura Restaurants",
      slug: "sakura-restaurants"
    });
    const project = await cloud.createProject(
      owner,
      dashboard.organization.organization_id,
      { name: "Sakura Loyalty", slug: "sakura-loyalty" }
    );
    const environment = await cloud.createEnvironment(owner, project.project_id, {
      name: "Staging",
      slug: "staging",
      kind: "staging",
      region: "us-east-1",
      program_id: "sakura-rewards"
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
  });
});
