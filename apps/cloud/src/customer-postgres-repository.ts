import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  CustomerRepositoryConflictError,
  type Customer,
  type CustomerConsent,
  type CustomerExternalIdentity,
  type CustomerLoyaltyMembership,
  type CustomerProfile,
  type CustomerRepository
} from "./customer-types.js";

export interface PostgresCustomerRepositoryOptions {
  connectionString?: string;
  pool?: Pool;
  poolConfig?: PoolConfig;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function customer(row: Record<string, unknown>): Customer {
  return {
    customer_id: String(row["customer_id"]),
    tenant_id: String(row["tenant_id"]),
    status: row["status"] as Customer["status"],
    profile: structuredClone(row["profile"] as CustomerProfile),
    created_at: iso(row["created_at"] as Date | string),
    updated_at: iso(row["updated_at"] as Date | string),
    ...(row["deleted_at"]
      ? { deleted_at: iso(row["deleted_at"] as Date | string) }
      : {})
  };
}

function identity(row: Record<string, unknown>): CustomerExternalIdentity {
  return {
    customer_id: String(row["customer_id"]),
    tenant_id: String(row["tenant_id"]),
    provider_id: String(row["provider_id"]),
    provider_kind: row["provider_kind"] as CustomerExternalIdentity["provider_kind"],
    issuer: String(row["issuer"]),
    subject: String(row["subject"]),
    active: Boolean(row["active"]),
    created_at: iso(row["created_at"] as Date | string),
    ...(row["disabled_at"]
      ? { disabled_at: iso(row["disabled_at"] as Date | string) }
      : {})
  };
}

function consent(row: Record<string, unknown>): CustomerConsent {
  return {
    customer_id: String(row["customer_id"]),
    tenant_id: String(row["tenant_id"]),
    purpose: String(row["purpose"]),
    status: row["status"] as CustomerConsent["status"],
    policy_version: String(row["policy_version"]),
    source: String(row["source"]),
    updated_at: iso(row["updated_at"] as Date | string)
  };
}

function membership(row: Record<string, unknown>): CustomerLoyaltyMembership {
  return {
    customer_id: String(row["customer_id"]),
    tenant_id: String(row["tenant_id"]),
    program_id: String(row["program_id"]),
    member_id: String(row["member_id"]),
    enrolled_at: iso(row["enrolled_at"] as Date | string)
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
  );
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresCustomerRepository implements CustomerRepository {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  public constructor(options: PostgresCustomerRepositoryOptions) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        ...(options.poolConfig ?? {}),
        ...(options.connectionString
          ? { connectionString: options.connectionString }
          : {})
      });
      this.ownsPool = true;
    }
  }

  public async migrate(): Promise<void> {
    const sql = await readFile(
      fileURLToPath(
        new URL("../migrations/003_customer_identity.sql", import.meta.url)
      ),
      "utf8"
    );
    await transaction(this.pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS lip_cloud_schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["lip:cloud:schema-migrations"]
      );
      const applied = await client.query(
        "SELECT 1 FROM lip_cloud_schema_migrations WHERE version = 3"
      );
      if (!applied.rowCount) {
        await client.query(sql);
        await client.query(
          "INSERT INTO lip_cloud_schema_migrations (version, name) VALUES (3, $1)",
          ["customer_identity"]
        );
      }
    });
  }

  public async resolveOrCreate(input: {
    customer: Customer;
    identity: CustomerExternalIdentity;
  }): Promise<{
    customer: Customer;
    identity: CustomerExternalIdentity;
    created: boolean;
  }> {
    const existing = await this.identityByKey(input.identity);
    if (existing) return this.resolved(existing, false);
    try {
      return await transaction(this.pool, async (client) => {
        const value = input.customer;
        await client.query(`
          INSERT INTO lip_cloud_customers (
            tenant_id, customer_id, status, profile, created_at, updated_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        `, [
          value.tenant_id,
          value.customer_id,
          value.status,
          JSON.stringify(value.profile),
          value.created_at,
          value.updated_at
        ]);
        const external = input.identity;
        await client.query(`
          INSERT INTO lip_cloud_customer_identities (
            tenant_id, issuer, subject, customer_id, provider_id,
            provider_kind, active, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          external.tenant_id,
          external.issuer,
          external.subject,
          external.customer_id,
          external.provider_id,
          external.provider_kind,
          external.active,
          external.created_at
        ]);
        return {
          customer: structuredClone(value),
          identity: structuredClone(external),
          created: true
        };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.identityByKey(input.identity);
      if (raced) return this.resolved(raced, false);
      throw new CustomerRepositoryConflictError(
        "customer_conflict",
        "Customer id is already in use"
      );
    }
  }

  public async customerById(
    tenantId: string,
    customerId: string
  ): Promise<Customer | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_customers WHERE tenant_id = $1 AND customer_id = $2",
      [tenantId, customerId]
    );
    return result.rows[0] ? customer(result.rows[0]) : undefined;
  }

  public async identitiesForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<CustomerExternalIdentity[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_customer_identities
      WHERE tenant_id = $1 AND customer_id = $2
      ORDER BY created_at
    `, [tenantId, customerId]);
    return result.rows.map(identity);
  }

  public async linkIdentity(input: {
    tenantId: string;
    customerId: string;
    identity: CustomerExternalIdentity;
  }): Promise<CustomerExternalIdentity> {
    try {
      await this.pool.query(`
        INSERT INTO lip_cloud_customer_identities (
          tenant_id, issuer, subject, customer_id, provider_id,
          provider_kind, active, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, true, $7)
      `, [
        input.tenantId,
        input.identity.issuer,
        input.identity.subject,
        input.customerId,
        input.identity.provider_id,
        input.identity.provider_kind,
        input.identity.created_at
      ]);
      return structuredClone(input.identity);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.identityByKey(input.identity);
      if (existing?.customer_id === input.customerId) return existing;
      throw new CustomerRepositoryConflictError(
        "identity_conflict",
        "External identity is already linked to another customer"
      );
    }
  }

  public async replaceProfile(input: {
    tenantId: string;
    customerId: string;
    profile: CustomerProfile;
    updatedAt: string;
  }): Promise<Customer | undefined> {
    const result = await this.pool.query(`
      UPDATE lip_cloud_customers
      SET profile = $3::jsonb, updated_at = $4
      WHERE tenant_id = $1 AND customer_id = $2 AND status = 'active'
      RETURNING *
    `, [
      input.tenantId,
      input.customerId,
      JSON.stringify(input.profile),
      input.updatedAt
    ]);
    return result.rows[0] ? customer(result.rows[0]) : undefined;
  }

  public async setConsent(value: CustomerConsent): Promise<CustomerConsent> {
    const result = await this.pool.query(`
      INSERT INTO lip_cloud_customer_consents (
        tenant_id, customer_id, purpose, status, policy_version, source, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, customer_id, purpose) DO UPDATE SET
        status = excluded.status,
        policy_version = excluded.policy_version,
        source = excluded.source,
        updated_at = excluded.updated_at
      RETURNING *
    `, [
      value.tenant_id,
      value.customer_id,
      value.purpose,
      value.status,
      value.policy_version,
      value.source,
      value.updated_at
    ]);
    return consent(result.rows[0]);
  }

  public async consentsForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<CustomerConsent[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_customer_consents
      WHERE tenant_id = $1 AND customer_id = $2
      ORDER BY purpose
    `, [tenantId, customerId]);
    return result.rows.map(consent);
  }

  public async bindLoyaltyMembership(
    value: CustomerLoyaltyMembership
  ): Promise<CustomerLoyaltyMembership> {
    try {
      const result = await this.pool.query(`
        INSERT INTO lip_cloud_customer_loyalty_memberships (
          tenant_id, customer_id, program_id, member_id, enrolled_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, customer_id, program_id) DO NOTHING
        RETURNING *
      `, [
        value.tenant_id,
        value.customer_id,
        value.program_id,
        value.member_id,
        value.enrolled_at
      ]);
      if (result.rows[0]) return membership(result.rows[0]);
      const existing = await this.loyaltyMembership(
        value.tenant_id,
        value.customer_id,
        value.program_id
      );
      if (!existing) throw new Error("Loyalty membership insert failed");
      return existing;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CustomerRepositoryConflictError(
          "member_conflict",
          "LIP member id is already mapped to another customer"
        );
      }
      throw error;
    }
  }

  public async loyaltyMembership(
    tenantId: string,
    customerId: string,
    programId: string
  ): Promise<CustomerLoyaltyMembership | undefined> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_customer_loyalty_memberships
      WHERE tenant_id = $1 AND customer_id = $2 AND program_id = $3
    `, [tenantId, customerId, programId]);
    return result.rows[0] ? membership(result.rows[0]) : undefined;
  }

  public async loyaltyMembershipsForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<CustomerLoyaltyMembership[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_customer_loyalty_memberships
      WHERE tenant_id = $1 AND customer_id = $2
      ORDER BY program_id
    `, [tenantId, customerId]);
    return result.rows.map(membership);
  }

  public async deleteCustomer(input: {
    tenantId: string;
    customerId: string;
    deletedAt: string;
  }): Promise<Customer | undefined> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE lip_cloud_customers
        SET status = 'deleted',
            profile = '{}'::jsonb,
            deleted_at = COALESCE(deleted_at, $3),
            updated_at = CASE WHEN status = 'deleted' THEN updated_at ELSE $3 END
        WHERE tenant_id = $1 AND customer_id = $2
        RETURNING *
      `, [input.tenantId, input.customerId, input.deletedAt]);
      if (!result.rows[0]) return undefined;
      await client.query(`
        UPDATE lip_cloud_customer_identities
        SET active = false, disabled_at = COALESCE(disabled_at, $3)
        WHERE tenant_id = $1 AND customer_id = $2
      `, [input.tenantId, input.customerId, input.deletedAt]);
      await client.query(`
        UPDATE lip_cloud_customer_consents
        SET status = 'withdrawn', updated_at = $3
        WHERE tenant_id = $1 AND customer_id = $2 AND status <> 'withdrawn'
      `, [input.tenantId, input.customerId, input.deletedAt]);
      return customer(result.rows[0]);
    });
  }

  public async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async identityByKey(
    value: Pick<CustomerExternalIdentity, "tenant_id" | "issuer" | "subject">
  ): Promise<CustomerExternalIdentity | undefined> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_customer_identities
      WHERE tenant_id = $1 AND issuer = $2 AND subject = $3
    `, [value.tenant_id, value.issuer, value.subject]);
    return result.rows[0] ? identity(result.rows[0]) : undefined;
  }

  private async resolved(
    external: CustomerExternalIdentity,
    created: boolean
  ): Promise<{
    customer: Customer;
    identity: CustomerExternalIdentity;
    created: boolean;
  }> {
    const resolvedCustomer = await this.customerById(
      external.tenant_id,
      external.customer_id
    );
    if (!resolvedCustomer) {
      throw new Error("Customer identity points to a missing customer");
    }
    return {
      customer: resolvedCustomer,
      identity: external,
      created
    };
  }
}
