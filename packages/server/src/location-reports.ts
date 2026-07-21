import type { LedgerEntry, LoyaltyUnit } from "@loyalty-interchange/protocol";
import type { LoyaltyEngine } from "@loyalty-interchange/reference";
import type { LocationEntry } from "./locations.js";

export interface LocationActivity {
  unit: LoyaltyUnit;
  accrued: number;
  redeemed: number;
  reversed: number;
  adjusted: number;
  manual: number;
  expired: number;
}

export interface LocationReservationCounts {
  reserved: number;
  captured: number;
  reversed: number;
}

export interface LocationReportRow {
  location_id: string;
  /** True when the location exists in the tenant's location registry. */
  registered: boolean;
  name?: string;
  franchisee_id?: string;
  active?: boolean;
  orders_accrued: number;
  ledger_entries: number;
  activity: LocationActivity[];
  reservations: LocationReservationCounts;
}

export interface UnattributedLocationActivity {
  ledger_entries: number;
  activity: LocationActivity[];
  reservations: LocationReservationCounts;
}

export interface LocationReport {
  generated_at: string;
  locations: LocationReportRow[];
  /**
   * Activity that cannot be attributed to a location: manual adjustments,
   * expirations, and entries recorded before location stamping existed.
   * Omitted for callers with a location scope.
   */
  unattributed?: UnattributedLocationActivity;
}

export interface LocationReportOptions {
  /** Registry entries used to enrich rows and list inactive locations. */
  locations?: LocationEntry[];
  /** Caller's allowed locations; undefined means every location. */
  scope?: string[];
}

interface MutableBucket {
  orders: Set<string>;
  ledgerEntries: number;
  activity: Map<LoyaltyUnit, LocationActivity>;
  reservations: LocationReservationCounts;
}

function emptyBucket(): MutableBucket {
  return {
    orders: new Set(),
    ledgerEntries: 0,
    activity: new Map(),
    reservations: { reserved: 0, captured: 0, reversed: 0 }
  };
}

function applyEntry(bucket: MutableBucket, entry: LedgerEntry): void {
  bucket.ledgerEntries += 1;
  const activity = bucket.activity.get(entry.unit) ?? {
    unit: entry.unit,
    accrued: 0,
    redeemed: 0,
    reversed: 0,
    adjusted: 0,
    manual: 0,
    expired: 0
  };
  if (entry.operation === "accrual") activity.accrued += entry.amount;
  if (entry.operation === "redemption") activity.redeemed += Math.abs(entry.amount);
  if (entry.operation === "reversal") activity.reversed += entry.amount;
  if (entry.operation === "adjustment") activity.adjusted += entry.amount;
  if (entry.operation === "manual") activity.manual += entry.amount;
  if (entry.operation === "expiration") activity.expired += Math.abs(entry.amount);
  bucket.activity.set(entry.unit, activity);
}

function sortedActivity(bucket: MutableBucket): LocationActivity[] {
  return [...bucket.activity.values()].sort((left, right) =>
    left.unit.localeCompare(right.unit)
  );
}

/**
 * Aggregates the engine's admin state per operating location. Accrual entries
 * carry the order's location directly; redemption, reversal, and adjustment
 * entries reference the originating order, so they are attributed through an
 * order-to-location map built from accruals. Everything else lands in the
 * unattributed bucket, which is withheld from location-scoped callers.
 */
export function locationReport(
  engine: LoyaltyEngine,
  options: LocationReportOptions = {}
): LocationReport {
  const snapshot = engine.inspectAdmin();
  const orderLocations = new Map<string, string>();
  for (const entry of snapshot.ledger) {
    if (entry.operation === "accrual" && entry.order_id && entry.location_id) {
      orderLocations.set(entry.order_id, entry.location_id);
    }
  }

  const buckets = new Map<string, MutableBucket>();
  const unattributed = emptyBucket();
  const bucketFor = (locationId: string): MutableBucket => {
    const bucket = buckets.get(locationId) ?? emptyBucket();
    buckets.set(locationId, bucket);
    return bucket;
  };
  const resolveLocation = (entry: LedgerEntry): string | undefined =>
    entry.location_id ??
    (entry.order_id ? orderLocations.get(entry.order_id) : undefined);

  for (const entry of snapshot.ledger) {
    const locationId = resolveLocation(entry);
    const bucket = locationId ? bucketFor(locationId) : unattributed;
    applyEntry(bucket, entry);
    if (entry.operation === "accrual" && entry.order_id && locationId) {
      bucket.orders.add(entry.order_id);
    }
  }
  for (const reservation of snapshot.reservations) {
    const locationId = orderLocations.get(reservation.order_id);
    const bucket = locationId ? bucketFor(locationId) : unattributed;
    if (reservation.status === "reserved") bucket.reservations.reserved += 1;
    if (reservation.status === "captured") bucket.reservations.captured += 1;
    if (reservation.status === "reversed") bucket.reservations.reversed += 1;
  }

  const registry = new Map<string, LocationEntry>(
    (options.locations ?? []).map((location) => [location.location_id, location])
  );
  const scope = options.scope ? new Set(options.scope) : undefined;
  const locationIds = [...new Set([...buckets.keys(), ...registry.keys()])]
    .filter((locationId) => !scope || scope.has(locationId))
    .sort((left, right) => left.localeCompare(right));

  return {
    generated_at: new Date().toISOString(),
    locations: locationIds.map((locationId) => {
      const bucket = buckets.get(locationId) ?? emptyBucket();
      const registered = registry.get(locationId);
      return {
        location_id: locationId,
        registered: Boolean(registered),
        ...(registered ? {
          name: registered.name,
          active: registered.active,
          ...(registered.franchisee_id ? { franchisee_id: registered.franchisee_id } : {})
        } : {}),
        orders_accrued: bucket.orders.size,
        ledger_entries: bucket.ledgerEntries,
        activity: sortedActivity(bucket),
        reservations: { ...bucket.reservations }
      };
    }),
    ...(scope ? {} : {
      unattributed: {
        ledger_entries: unattributed.ledgerEntries,
        activity: sortedActivity(unattributed),
        reservations: { ...unattributed.reservations }
      }
    })
  };
}
