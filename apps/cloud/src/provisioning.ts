import type {
  CloudEnvironment,
  CloudProvisioningJob,
  CloudProvisioningResult,
  CloudRepository
} from "./types.js";

export interface CloudProvisioner {
  provision(input: {
    environment: CloudEnvironment;
    job: CloudProvisioningJob;
  }): Promise<CloudProvisioningResult>;
}

export interface CloudProvisioningWorkerOptions {
  repository: CloudRepository;
  provisioner: CloudProvisioner;
  workerId: string;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export class CloudProvisioningWorker {
  private readonly repository: CloudRepository;
  private readonly provisioner: CloudProvisioner;
  private readonly workerId: string;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly onError: (error: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(options: CloudProvisioningWorkerOptions) {
    if (!options.workerId.trim()) throw new Error("Provisioning worker id is required");
    this.repository = options.repository;
    this.provisioner = options.provisioner;
    this.workerId = options.workerId;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.onError = options.onError ?? ((error) => console.error("[lip-cloud] provisioning failed", error));
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.pollIntervalMs);
    this.timer.unref();
    void this.runOnce();
  }

  public async runOnce(): Promise<"idle" | "succeeded" | "retrying" | "failed"> {
    if (this.running) return "idle";
    this.running = true;
    try {
      const job = await this.repository.claimProvisioningJob(
        this.workerId,
        this.leaseSeconds
      );
      if (!job) return "idle";
      const environment = await this.repository.environmentById(job.environment_id);
      if (!environment) {
        await this.repository.failProvisioningJob(
          job.provisioning_job_id,
          "Provisioning environment was not found"
        );
        return "failed";
      }
      try {
        const result = await this.provisioner.provision({ environment, job });
        await this.repository.completeProvisioningJob(
          job.provisioning_job_id,
          result
        );
        return "succeeded";
      } catch (error) {
        const message = error instanceof Error ? error.message : "Provisioning failed";
        const exhausted = job.attempts >= 5;
        const retryAt = exhausted
          ? undefined
          : new Date(
              Date.now() + Math.min(300_000, 2 ** job.attempts * 1_000)
            ).toISOString();
        await this.repository.failProvisioningJob(
          job.provisioning_job_id,
          message,
          retryAt
        );
        this.onError(error);
        return exhausted ? "failed" : "retrying";
      }
    } finally {
      this.running = false;
    }
  }

  public close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
