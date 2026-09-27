import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
	testDir: "./test",
	testMatch: "**/*.browser.spec.mjs",
	fullyParallel: false,
	workers: 1,
	timeout: 90_000,
	expect: { timeout: 10_000 },
	use: {
		browserName: "chromium",
		headless: true,
		launchOptions: executablePath ? { executablePath } : {},
	},
});
