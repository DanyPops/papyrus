/**
 * Narrow, gap-filling ESLint config -- Biome (biome.json) is the primary
 * linter/formatter here. This only covers what Biome 2.x still can't:
 * full type-aware no-floating-promises, import-cycle detection, and a
 * custom barrel-import ban.
 */
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["**/dist/**", "**/*.d.ts"] },

	{
		files: ["packages/*/src/**/*.ts", "packages/*/extension/**/*.ts", "packages/*/test/**/*.ts"],
		languageOptions: { parser: tseslint.parser },
		plugins: { "import-x": importX },
		settings: {
			"import-x/resolver": { typescript: true },
		},
		rules: {
			"import-x/no-cycle": ["error", { maxDepth: 3, ignoreExternal: true }],
			"no-restricted-imports": ["error", {
				patterns: [{
					group: ["../index", "../index.js", "../../index", "../../index.js"],
					message: "Do not import from barrel files. Import from the source module, or a dedicated package.json subpath, instead.",
				}],
			}],
		},
	},

	{
		files: ["packages/*/src/**/*.ts", "packages/*/extension/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: { "@typescript-eslint": tseslint.plugin },
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
		},
	},
);
