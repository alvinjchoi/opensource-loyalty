import type { RedemptionReservation } from "@loyalty-interchange/protocol";

/** Reservation outcomes tallied across all four protocol statuses. */
export interface ReservationStatusCounts {
  reserved: number;
  captured: number;
  reversed: number;
  expired: number;
}

export function emptyReservationStatusCounts(): ReservationStatusCounts {
  return { reserved: 0, captured: 0, reversed: 0, expired: 0 };
}

/**
 * Counts reservations by `status`. The protocol defines four reservation
 * statuses, so counting through this record keeps reports and analytics from
 * silently dropping a status (expired reservations were previously lost).
 */
export function countReservationStatuses(
  reservations: Iterable<RedemptionReservation>
): ReservationStatusCounts {
  let counts = emptyReservationStatusCounts();
  for (const reservation of reservations) {
    counts = { ...counts, [reservation.status]: counts[reservation.status] + 1 };
  }
  return counts;
}
