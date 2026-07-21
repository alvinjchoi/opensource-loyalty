import type { LedgerEntry, LoyaltyUnit } from "@loyalty-interchange/protocol";
import type { LoyaltyEngine } from "@loyalty-interchange/reference";
import type { LocationEntry } from "./locations.js";
import {
  countReservationStatuses,
  type ReservationStatusCounts
} from "./reservation-counts.js";

export interface LocationActivity {
  unit: LoyaltyUnit;
  accrued: number;
  redeemed: number;
  reversed: number;
  adjusted: number;
  manual: number;
  expired: number;
}

export type LocationReservationCounts = ReservationStatusCounts;

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
  /**
   * For location-scoped callers only: true when activity exists outside the
   * caller's view (the unattributed bucket is non-empty), without exposing
   * any amounts.
   */
  unattributed_present?: boolean;
}

export interface LocationReportOptions {
  /** Registry entries used to enrich rows and list inactive locations. */
  locations?: LocationEntry[];
  /** Caller's allowed locations; undefined means every location. */
  scope?: string[];
}

interface AttributedItems<T> {
  attributed: ReadonlyMap<string, readonly T[]>;
  unattributed: readonly T[];
}

function groupByLocation<T>(
  items: readonly T[],
  locate: (item: T) => string | undefined
): AttributedItems<T> {
  return items.reduce<AttributedItems<T>>(
    (grouped, item) => {
      const locationId = locate(item);
      if (!locationId) {
        return {
          attributed: grouped.attributed,
          unattributed: [...grouped.unattributed, item]
        };
      }
      const attributed = new Map(grouped.attributed);
      attributed.set(locationId, [...(attributed.get(locationId) ?? []), item]);
      return { attributed, unattributed: grouped.unattributed };
    },
    { attributed: new Map(), unattributed: [] }
  );
}

function emptyActivity(unit: LoyaltyUnit): LocationActivity {
  return { unit, accrued: 0, redeemed: 0, reversed: 0, adjusted: 0, manual: 0, expired: 0 };
}

function withEntry(activity: LocationActivity, entry: LedgerEntry): LocationActivity {
  return {
    ...activity,
    accrued: activity.accrued + (entry.operation === "accrual" ? entry.amount : 0),
    redeemed: activity.redeemed +
      (entry.operation === "redemption" ? Math.abs(entry.amount) : 0),
    reversed: activity.reversed + (entry.operation === "reversal" ? entry.amount : 0),
    adjusted: activity.adjusted + (entry.operation === "adjustment" ? entry.amount : 0),
    manual: activity.manual + (entry.operation === "manual" ? entry.amount : 0),
    expired: activity.expired +
      (entry.operation === "expiration" ? Math.abs(entry.amount) : 0)
  };
}

function activityFor(entries: readonly LedgerEntry[]): LocationActivity[] {
  const byUnit = entries.reduce(
    (units, entry) => new Map(units).set(
      entry.unit,
      withEntry(units.get(entry.unit) ?? emptyActivity(entry.unit), entry)
    ),
    new Map<LoyaltyUnit, LocationActivity>()
  );
  return [...byUnit.values()].sort((left, right) => left.unit.localeCompare(right.unit));
}

function accruedOrderCount(entries: readonly LedgerEntry[]): number {
  return new Set(
    entries
      .filter((entry) => entry.operation === "accrual" && entry.order_id)
      .map((entry) => entry.order_id)
  ).size;
}

/**
 * Aggregates the engine's admin state per operating location. Ledger entries
 * stamped with `location_id` at write time (accruals from the accrued order,
 * redemptions/reversals from the reserving order) are attributed directly;
 * entries recorded before stamping existed fall back to the reservation's
 * stamped location and then to an order-to-location map built from accruals.
 * Everything else lands in the unattributed bucket, which is withheld from
 * location-scoped callers (they only learn whether it is non-empty).
 */
export function locationReport(
  engine: LoyaltyEngine,
  options: LocationReportOptions = {}
): LocationReport {
  const { ledger, reservations } = engine.inspectLedger();
  const orderLocations = new Map<string, string>(
    ledger
      .filter((entry) => entry.operation === "accrual" && entry.order_id && entry.location_id)
      .map((entry) => [entry.order_id!, entry.location_id!])
  );
  const reservationLocations = new Map<string, string>(
    reservations
      .filter((reservation) => reservation.location_id)
      .map((reservation) => [reservation.reservation_id, reservation.location_id!])
  );

  const entriesByLocation = groupByLocation(ledger, (entry) =>
    entry.location_id ??
    (entry.reservation_id ? reservationLocations.get(entry.reservation_id) : undefined) ??
    (entry.order_id ? orderLocations.get(entry.order_id) : undefined)
  );
  const reservationsByLocation = groupByLocation(reservations, (reservation) =>
    reservation.location_id ?? orderLocations.get(reservation.order_id)
  );

  const registry = new Map<string, LocationEntry>(
    (options.locations ?? []).map((location) => [location.location_id, location])
  );
  const scope = options.scope ? new Set(options.scope) : undefined;
  const locationIds = [...new Set([
    ...entriesByLocation.attributed.keys(),
    ...reservationsByLocation.attributed.keys(),
    ...registry.keys()
  ])]
    .filter((locationId) => !scope || scope.has(locationId))
    .sort((left, right) => left.localeCompare(right));

  const unattributedPresent =
    entriesByLocation.unattributed.length > 0 ||
    reservationsByLocation.unattributed.length > 0;

  return {
    generated_at: new Date().toISOString(),
    locations: locationIds.map((locationId) => {
      const entries = entriesByLocation.attributed.get(locationId) ?? [];
      const registered = registry.get(locationId);
      return {
        location_id: locationId,
        registered: Boolean(registered),
        ...(registered ? {
          name: registered.name,
          active: registered.active,
          ...(registered.franchisee_id ? { franchisee_id: registered.franchisee_id } : {})
        } : {}),
        orders_accrued: accruedOrderCount(entries),
        ledger_entries: entries.length,
        activity: activityFor(entries),
        reservations: countReservationStatuses(
          reservationsByLocation.attributed.get(locationId) ?? []
        )
      };
    }),
    ...(scope
      ? { unattributed_present: unattributedPresent }
      : {
          unattributed: {
            ledger_entries: entriesByLocation.unattributed.length,
            activity: activityFor(entriesByLocation.unattributed),
            reservations: countReservationStatuses(reservationsByLocation.unattributed)
          }
        })
  };
}
