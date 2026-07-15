import type {
  FoodserviceOrder,
  Money,
  OrderChannel,
  OrderLine,
  ProgramScope
} from "@loyalty-interchange/protocol";
import { validateFoodserviceOrder } from "@loyalty-interchange/protocol";
import { LipValidationError } from "./errors.js";
import { addMoney, money, zeroMoney } from "./money.js";

type Tender = NonNullable<FoodserviceOrder["tenders"]>[number];
type OrderStatus = FoodserviceOrder["status"];

export interface OrderBuilderOptions {
  orderId: string;
  scope: ProgramScope;
  currency: string;
  channel: OrderChannel;
  businessDate: string;
  placedAt?: string;
  orderNumber?: string;
  memberId?: string;
  status?: OrderStatus;
}

export interface OrderBuilderLine {
  lineId: string;
  productId: string;
  unitPrice: Money;
  quantity?: number;
  discount?: Money;
  tax?: Money;
  sku?: string;
  name?: string;
  categoryIds?: string[];
  tags?: string[];
  loyaltyEligible?: boolean;
  metadata?: Record<string, unknown>;
}

export interface OrderBuilderTender {
  tenderId: string;
  type: Tender["type"];
  amount: Money;
}

export class FoodserviceOrderBuilder {
  private readonly options: OrderBuilderOptions;
  private readonly lines: OrderLine[] = [];
  private readonly tenders: Tender[] = [];
  private tip: Money;
  private serviceCharge: Money;
  private closedAt?: string;

  public constructor(options: OrderBuilderOptions) {
    this.options = structuredClone(options);
    this.tip = zeroMoney(options.currency);
    this.serviceCharge = zeroMoney(options.currency);
  }

  public addItem(input: OrderBuilderLine): this {
    return this.addLine("item", input);
  }

  public addModifier(parentLineId: string, input: OrderBuilderLine): this {
    return this.addLine("modifier", input, parentLineId);
  }

  public addFee(input: OrderBuilderLine): this {
    return this.addLine("fee", input);
  }

  public addTender(input: OrderBuilderTender): this {
    this.assertCurrency(input.amount);
    this.tenders.push({
      tender_id: input.tenderId,
      type: input.type,
      amount: structuredClone(input.amount)
    });
    return this;
  }

  public setTip(value: Money): this {
    this.assertCurrency(value);
    this.tip = structuredClone(value);
    return this;
  }

  public setServiceCharge(value: Money): this {
    this.assertCurrency(value);
    this.serviceCharge = structuredClone(value);
    return this;
  }

  public close(at: string): this {
    this.closedAt = at;
    return this;
  }

  public build(): FoodserviceOrder {
    const currency = this.options.currency;
    const subtotal = addMoney(zeroMoney(currency), ...this.lines.map((line) => line.subtotal));
    const discount = addMoney(zeroMoney(currency), ...this.lines.map((line) => line.discount));
    const tax = addMoney(zeroMoney(currency), ...this.lines.map((line) => line.tax));
    const total = addMoney(
      subtotal,
      money(-discount.amount, currency),
      tax,
      this.tip,
      this.serviceCharge
    );
    const order: FoodserviceOrder = {
      order_id: this.options.orderId,
      scope: structuredClone(this.options.scope),
      channel: this.options.channel,
      status: this.options.status ?? "open",
      business_date: this.options.businessDate,
      placed_at: this.options.placedAt ?? new Date().toISOString(),
      lines: structuredClone(this.lines),
      totals: {
        subtotal,
        discount,
        tax,
        tip: structuredClone(this.tip),
        service_charge: structuredClone(this.serviceCharge),
        total
      },
      ...(this.options.orderNumber ? { order_number: this.options.orderNumber } : {}),
      ...(this.options.memberId ? { member_id: this.options.memberId } : {}),
      ...(this.closedAt ? { closed_at: this.closedAt } : {}),
      ...(this.tenders.length > 0 ? { tenders: structuredClone(this.tenders) } : {})
    };
    const validation = validateFoodserviceOrder(order);
    if (!validation.ok) throw new LipValidationError("request", validation.issues);
    return order;
  }

  private addLine(kind: OrderLine["kind"], input: OrderBuilderLine, parentLineId?: string): this {
    this.assertCurrency(input.unitPrice);
    const discount = input.discount ?? zeroMoney(this.options.currency);
    const tax = input.tax ?? zeroMoney(this.options.currency);
    this.assertCurrency(discount);
    this.assertCurrency(tax);
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new RangeError("line quantity must be a positive integer");
    }

    this.lines.push({
      line_id: input.lineId,
      kind,
      product_id: input.productId,
      quantity,
      unit_price: structuredClone(input.unitPrice),
      subtotal: money(
        Number(BigInt(input.unitPrice.amount) * BigInt(quantity)),
        this.options.currency
      ),
      discount: structuredClone(discount),
      tax: structuredClone(tax),
      ...(parentLineId ? { parent_line_id: parentLineId } : {}),
      ...(input.sku ? { sku: input.sku } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.categoryIds ? { category_ids: [...input.categoryIds] } : {}),
      ...(input.tags ? { tags: [...input.tags] } : {}),
      ...(input.loyaltyEligible !== undefined ? { loyalty_eligible: input.loyaltyEligible } : {}),
      ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {})
    });
    return this;
  }

  private assertCurrency(value: Money): void {
    if (value.currency !== this.options.currency) {
      throw new RangeError(`expected ${this.options.currency}, received ${value.currency}`);
    }
  }
}
