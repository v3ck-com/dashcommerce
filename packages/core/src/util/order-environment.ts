/** Legacy records without mode retain their previous classification; never infer live from a test marker. */
export function isTestOrder(order: {
	paymentMode?: string;
	paymentProvider?: string;
	metadata?: Record<string, unknown>;
}): boolean {
	return (
		order.paymentMode === "test" ||
		order.paymentProvider === "paystack-test" ||
		order.metadata?.testMode === true
	);
}
