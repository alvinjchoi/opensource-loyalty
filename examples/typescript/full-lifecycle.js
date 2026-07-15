import { FoodserviceOrderBuilder, LipClient, money } from "@loyalty-interchange/sdk";
const runId = `${Date.now()}`;
const memberId = `sdk-member-${runId}`;
const businessDate = new Date().toISOString().slice(0, 10);
const client = new LipClient({
    baseUrl: process.env.LIP_BASE_URL ?? "http://127.0.0.1:3210",
    apiKey: process.env.LIP_API_KEY ?? "lip-dev-key",
    source: { system: "typescript-example", instance: "local" }
});
const scope = { program_id: "demo-foodservice", brand_id: "demo-brand",
    merchant_id: "demo-merchant", location_id: "demo-location" };
function order(orderId, amount, status) {
    const builder = new FoodserviceOrderBuilder({
        orderId, scope, memberId, currency: "USD", channel: "mobile", businessDate, status
    }).addItem({ lineId: "line-1", productId: "meal", name: "Meal", unitPrice: money(amount, "USD") });
    if (status === "paid") {
        builder.addTender({ tenderId: "tender-1", type: "card", amount: money(amount, "USD") })
            .close(new Date().toISOString());
    }
    return builder.build();
}
const earningOrder = order(`earn-${runId}`, 5000, "paid");
await client.members.enroll({ program_id: scope.program_id,
    identity: { type: "token", value: `guest-${runId}` }, member_id: memberId });
const evaluation = await client.orders.evaluate({ member_id: memberId, order: earningOrder });
const accrual = await client.accruals.post({ member_id: memberId, order: earningOrder,
    evaluation_id: evaluation.evaluation_id });
const redemptionOrder = order(`redeem-${runId}`, 1200, "open");
const reserved = await client.redemptions.reserve({ redemption_id: `redemption-${runId}`,
    member_id: memberId, reward_id: "five-off", order: redemptionOrder });
const captured = await client.redemptions.capture({
    reservation_id: reserved.reservation.reservation_id, order_id: redemptionOrder.order_id
});
const reversed = await client.redemptions.reverse({
    reservation_id: reserved.reservation.reservation_id, reason: "Example reversal"
});
const adjusted = await client.orders.adjust({ member_id: memberId, program_id: scope.program_id,
    adjustment: { adjustment_id: `refund-${runId}`, original_order_id: earningOrder.order_id,
        type: "partial_refund", reason: "Example refund", occurred_at: new Date().toISOString(),
        order_total_delta: money(-1000, "USD"), eligible_spend_delta: money(-1000, "USD") } });
console.log({ memberId, estimated: evaluation.estimated_accrual.amount,
    accrued: accrual.balances[0]?.amount, captured: captured.balances[0]?.amount,
    reversed: reversed.balances[0]?.amount, adjusted: adjusted.balances[0]?.amount });
//# sourceMappingURL=full-lifecycle.js.map