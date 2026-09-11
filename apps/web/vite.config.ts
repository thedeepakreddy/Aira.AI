import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tailwind runs through PostCSS rather than the Vite plugin, matching the
// reference project's pipeline exactly so the generated CSS is identical.
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5180, strictPort: true, host: '127.0.0.1' },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'auth', test: /node_modules[\\/]@supabase[\\/]/, priority: 20 },
            { name: 'controls', test: /node_modules[\\/]@base-ui[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
});
