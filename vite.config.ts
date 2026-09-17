import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
export default defineConfig({ css: { postcss: { plugins: [tailwindcss()] } }, build: { rolldownOptions: { external: ['cloudflare:workers'] } }, plugins: [vinext()] });
