import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'node:child_process';

// ── Version stamp buat ditampilkan di UI (lihat AppVersionBadge di App.jsx)
// dan buat deteksi "ada update baru" (lihat useAppUpdateCheck) ─────────────
// Commit hash: Vercel otomatis nyediain VERCEL_GIT_COMMIT_SHA di environment
// build (lihat https://vercel.com/docs/environment-variables/system-environment-variables),
// jadi itu prioritas utama karena selalu akurat persis sama deployment yang
// jalan di Vercel. Kalau lagi build lokal (`npm run build` / `npm run dev`
// di laptop, bukan di Vercel), fallback ke `git rev-parse` lokal. Kalau
// dua-duanya gagal (misal folder .git gak ada sama sekali), fallback ke
// 'dev' — build tetap jalan, cuma version badge-nya kurang informatif.
function getCommitHash() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  }
  try {
    return execSync('git rev-parse --short=7 HEAD').toString().trim();
  } catch {
    return 'dev';
  }
}

// Build timestamp — ini yang PALING PENTING buat force-refresh/update-check,
// karena selalu berubah tiap kali `vite build` dijalankan (beda dari commit
// hash yang bisa sama kalau redeploy tanpa commit baru). Dipakai sebagai
// "nomor seri" build: kalau timestamp yang di server beda dari yang lagi
// dipakai browser, berarti ada build baru yang belum ke-load.
const BUILD_TIME = new Date().toISOString();

// Plugin kecil buat nyuntik <meta name="app-build" content="..."> ke
// index.html hasil build. Ini KUNCI dari deteksi-update-otomatis di
// appUpdate.js (checkForNewBuild): browser yang lagi buka app poll
// /index.html tiap beberapa saat dan baca meta tag ini — kalau isinya beda
// dari __APP_VERSION__ yang lagi jalan di memori, berarti ada build baru
// sudah live di server. Ditaruh di <head>, bukan cuma di JS bundle, supaya
// bisa dibaca lewat fetch teks biasa tanpa perlu eksekusi/parse JavaScript
// sama sekali (jauh lebih ringan buat dipoll berkali-kali).
function injectBuildMetaPlugin() {
  return {
    name: 'inject-build-meta',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `    <meta name="app-build" content="${BUILD_TIME}" />\n  </head>`
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), injectBuildMetaPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_TIME),
    __APP_COMMIT__: JSON.stringify(getCommitHash()),
  },
});