import { defineConfig, globalIgnores } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";

/**
 * ESLint enforcing the layered architecture & CloudCanvas client boundaries (`ARCHITECTURE.md`):
 *
 *   src/api/handlers/** -> `@/src/core` + `@/src/server` barrels ONLY
 *   src/core/**         -> pure core; never imports agent, memory, server, store, api, or client
 *   src/agent/**        -> never imports memory, server, store, api, or client
 *   src/client/**       -> browser-only; never imports server, api, agent, memory, or store
 *   src/client/kit/**   -> strictly product-agnostic CloudCanvas UI controls (0 peer imports)
 *   src/client/engine/**-> pure framework-free client mechanics (imports ONLY src/core + math/layout vendors)
 *   src/client/views/** -> views & blocks never import src/client/state directly
 */

export default defineConfig([
	globalIgnores([
		"node_modules/**",
		"data/**",
		"scripts/**",
		"electron/**",
		"dist/**",
		"extern/**",
		"core-plugins/**",
		"plugins/**",
		".test-scratch/**",
		"public/client/build/**",
	]),
	{
		files: ["**/*.{js,mjs,ts}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: "latest", sourceType: "module" },
		},
		plugins: { import: importPlugin },
		settings: {
			"import/resolver": { typescript: { alwaysTryTypes: true } },
		},
		rules: {
			"import/no-restricted-paths": [
				"error",
				{
					zones: [
						{
							target: "./src/api/handlers",
							from: "./src",
							except: ["./core/index.ts", "./server/index.ts"],
							message:
								"API route handlers import ONLY the barrels: `@/src/core` and `@/src/server`.",
						},
						{
							target: "./src/core",
							from: ["./src/agent", "./src/memory", "./src/server", "./src/store", "./src/api", "./src/client"],
							message:
								"Pure core never imports IO or client layers (agent/memory/server/store/api/client).",
						},
						{
							target: "./src/agent",
							from: ["./src/memory", "./src/server", "./src/store", "./src/api", "./src/client"],
							message:
								"The agent layer receives storage ports via factories/closures and never imports memory, server, store, api, or client.",
						},
						{
							target: "./src/client",
							from: ["./src/agent", "./src/memory", "./src/server", "./src/store", "./src/api"],
							message:
								"Browser client code never imports server, api, agent, memory, or store layers.",
						},
						{
							target: "./src/client/kit",
							from: [
								"./src/core",
								"./src/client/state",
								"./src/client/views",
								"./src/client/blocks",
								"./src/client/theme",
								"./src/client/engine",
							],
							message:
								"src/client/kit/ contains strictly product-agnostic CloudCanvas UI controls and must NEVER import peer modules.",
						},
						{
							target: "./src/client/engine",
							from: [
								"./src/client/state",
								"./src/client/views",
								"./src/client/blocks",
								"./src/client/theme",
								"./src/client/kit",
							],
							message:
								"src/client/engine/ contains pure framework-free domain/canvas mechanics and may import ONLY src/core and vendor math/layout libraries.",
						},
						{
							target: ["./src/client/views", "./src/client/blocks"],
							from: "./src/client/state",
							message:
								"Views and blocks never import src/client/state directly; only src/client/main.js imports peer-state.",
						},
					],
				},
			],
		},
	},
]);
