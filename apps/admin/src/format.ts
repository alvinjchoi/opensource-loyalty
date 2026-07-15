export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDate(value: string, includeTime = false): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-US", includeTime
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric" }
  ).format(date);
}

export function memberName(attributes: Record<string, unknown> | undefined, memberId: string): string {
  return typeof attributes?.name === "string" && attributes.name.trim()
    ? attributes.name
    : memberId;
}

export function percentage(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 2)}%`;
}
