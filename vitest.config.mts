import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// n8n loads community nodes as CommonJS; test against the same build of n8n-workflow
		alias: {
			'n8n-workflow': fileURLToPath(
				new URL('./node_modules/n8n-workflow/dist/cjs/index.js', import.meta.url),
			),
		},
	},
	test: {
		include: ['test/**/*.test.ts'],
	},
});
