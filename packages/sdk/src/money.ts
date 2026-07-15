import type { Money } from "@loyalty-interchange/protocol";

function assertCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RangeError("currency must be a three-letter uppercase ISO 4217 code");
  }
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 9) {
    throw new RangeError("scale must be an integer between 0 and 9");
  }
}

export function money(amount: number, currency: string): Money {
  assertCurrency(currency);
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError("money amount must be a safe integer in minor units");
  }
  return { amount, currency };
}

export function moneyFromDecimal(value: string, currency: string, scale = 2): Money {
  assertCurrency(currency);
  assertScale(scale);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new RangeError("decimal money must contain only an optional sign, digits, and decimal point");
  }
  const fraction = match[3] ?? "";
  if (fraction.length > scale) {
    throw new RangeError(`decimal money has more than ${scale} fractional digits`);
  }

  const factor = 10n ** BigInt(scale);
  const magnitude = BigInt(match[2]!) * factor + BigInt(fraction.padEnd(scale, "0") || "0");
  const signed = match[1] === "-" ? -magnitude : magnitude;
  const amount = Number(signed);
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError("money amount exceeds the safe integer range");
  }
  return { amount, currency };
}

export function formatMoney(value: Money, scale = 2): string {
  assertCurrency(value.currency);
  assertScale(scale);
  if (!Number.isSafeInteger(value.amount)) {
    throw new RangeError("money amount must be a safe integer");
  }
  const negative = value.amount < 0;
  const digits = Math.abs(value.amount).toString().padStart(scale + 1, "0");
  const formatted = scale === 0
    ? digits
    : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return `${negative ? "-" : ""}${formatted} ${value.currency}`;
}

export function addMoney(...values: Money[]): Money {
  if (values.length === 0) throw new RangeError("addMoney requires at least one value");
  const currency = values[0]!.currency;
  let amount = 0n;
  for (const value of values) {
    if (value.currency !== currency) {
      throw new RangeError("cannot add money in different currencies");
    }
    money(value.amount, value.currency);
    amount += BigInt(value.amount);
  }
  return money(Number(amount), currency);
}

export function zeroMoney(currency: string): Money {
  return money(0, currency);
}
