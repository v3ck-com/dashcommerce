/** Node-only descriptor/build helper; never imported by the plugin runtime. */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function detectEmDashVersionAtBuildTime(): string | null {
	try {
		// EmDash does not export package.json. Resolve its public entry instead,
		// then locate that package's manifest; works in both Node ESM and Bun.
		let directory = dirname(createRequire(import.meta.url).resolve("emdash"));
		for (let depth = 0; depth < 8; depth++) {
			try {
				const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
				if (manifest.name === "emdash" && typeof manifest.version === "string")
					return manifest.version;
			} catch {
				/* continue from dist/ to the package root */
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	} catch {
		/* missing package: the descriptor must fail closed */
	}
	return null;
}
