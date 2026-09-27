export class PaymentProviderError extends Error {
	status: number;
	code: string;
	orderDraftId?: string;
	constructor(
		message: string,
		opts: { status?: number; code?: string; orderDraftId?: string } = {},
	) {
		super(message);
		this.name = "PaymentProviderError";
		this.status = opts.status ?? 400;
		this.code = opts.code ?? "payment_provider_error";
		this.orderDraftId = opts.orderDraftId;
	}
}
