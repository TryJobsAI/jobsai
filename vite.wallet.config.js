import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/wallet/',
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: 'dist/wallet',
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: { auth: 'src/auth-app.jsx', workspace: 'src/workspace-app.jsx', team: 'src/team-app.jsx' },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: asset => asset.name?.endsWith('.css') ? 'wallet.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
