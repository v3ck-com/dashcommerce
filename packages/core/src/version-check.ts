/** This experimental host bridge targets one exact EmDash package artifact. */
export const SUPPORTED_EMDASH_RANGE = {
	min: "0.41.0",
	max: "0.41.1", // exclusive; prereleases are not accepted
} as const;

export function checkEmDashVersion(installedVersion: string): void {
	if (installedVersion !== SUPPORTED_EMDASH_RANGE.min) {
		throw new Error(
			`DashCommerce spike requires exactly EmDash ${SUPPORTED_EMDASH_RANGE.min}; found ${installedVersion}. ` +
				"Restore this fork's pinned dependencies and host patch. Do not bypass the check or substitute the published DashCommerce package.",
		);
	}
}

/** The Node build descriptor passes its detected version to this portable runtime. */
export function validateEmDashCompatibility(emdashVersion?: string): void {
	if (!emdashVersion) {
		throw new Error("DashCommerce spike requires an explicitly detected EmDash version.");
	}
	checkEmDashVersion(emdashVersion);
	console.log(`[DashCommerce] ✓ EmDash ${emdashVersion} compatibility verified`);
}
