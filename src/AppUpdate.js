// ============================================================================
// VERSION & FORCE-REFRESH — biar Agung/karyawan bisa lihat app udah update
// ke build terbaru apa belum, dan bisa maksa refresh dari HP tanpa perlu
// Ctrl+Shift+R (yang gak ada di keyboard HP).
// ============================================================================
//
// __APP_VERSION__ dan __APP_COMMIT__ di-inject Vite lewat `define` di
// vite.config.js — __APP_VERSION__ adalah timestamp ISO saat `vite build`
// dijalankan (jadi SELALU beda tiap build, walau commit git-nya sama persis
// misal cuma redeploy), __APP_COMMIT__ adalah 7 karakter pertama git SHA
// (dari VERCEL_GIT_COMMIT_SHA kalau di-deploy Vercel, atau git lokal kalau
// build di laptop). Kedua-duanya string biasa di runtime, bukan proses async
// apa pun, jadi aman dipakai langsung tanpa loading state.

export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
export const APP_COMMIT = typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'dev';

// Format singkat buat ditampilkan di badge — commit hash + jam:menit build
// (bukan tanggal lengkap, karena di badge kecil gak muat & jarang perlu
// presisi hari — kalau perlu detail penuh, lihat formatVersionFull).
export function formatVersionShort() {
  if (APP_VERSION === 'dev') return 'dev';
  const d = new Date(APP_VERSION);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${APP_COMMIT} · ${hh}.${mm}`;
}

// Format lengkap buat tooltip/detail — dipakai di dalam modal force-refresh,
// biar Agung bisa mastiin persis build tanggal berapa jam berapa yang lagi
// jalan di HP-nya saat itu.
export function formatVersionFull() {
  if (APP_VERSION === 'dev') return 'Build lokal (development)';
  const d = new Date(APP_VERSION);
  return d.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ` WIB · commit ${APP_COMMIT}`;
}

// ── Force refresh ───────────────────────────────────────────────────────────
// Ctrl+Shift+R di laptop pada dasarnya: (1) buang semua cache yang browser
// simpan buat origin ini, (2) reload tanpa pakai apa pun dari cache. Di HP
// gak ada shortcut itu, jadi kita bikin ulang efeknya lewat JS:
// 1. Hapus semua Cache Storage (dipakai service worker/PWA — app ini sendiri
//    gak pasang service worker, tapi kalau browser HP tertentu atau versi
//    lama app ini pernah bikin satu, ini jaga-jaga bersihin sisa-sisanya).
// 2. Unregister semua service worker yang somehow kedaftar buat origin ini.
// 3. Reload pakai query param cache-busting (?_r=timestamp) SEKALIGUS
//    location.reload() — kombinasi ini yang paling reliable buat maksa
//    browser HP (Chrome/Safari mobile) narik ulang index.html & JS bundle
//    dari server, bukan dari cache HTTP biasa (yang cuma reload() polos
//    kadang masih kena, terutama di Android WebView/in-app browser WA).
export async function forceRefreshApp() {
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (_) {
    // Cache API gak tersedia/gagal dihapus — lanjut aja, bukan blocker.
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    }
  } catch (_) {
    // Sama — bukan blocker kalau gagal.
  }

  // Cache-busting param + reload. Pakai location.href (bukan reload() saja)
  // supaya URL berubah (ada ?_r=...), yang memaksa request baru ke server
  // alih-alih ada kemungkinan diservice dari cache HTTP browser yang masih
  // menganggap URL persis sama = boleh pakai cache lama.
  const url = new URL(window.location.href);
  url.searchParams.set('_r', Date.now().toString());
  window.location.href = url.toString();
}

// ── Deteksi otomatis "ada update baru" ──────────────────────────────────────
// Poll index.html tiap beberapa saat, baca meta tag <meta name="app-build">
// yang isinya APP_VERSION build itu (lihat index.html) — kalau beda dari
// APP_VERSION yang lagi jalan di browser sekarang, berarti ada build baru
// sudah ke-deploy di server tapi Agung/karyawan masih buka versi lama.
//
// Dipanggil dari hook useAppUpdateCheck di App.jsx, bukan langsung di sini,
// supaya urusan re-render/state tetap di komponen React.
export async function checkForNewBuild() {
  try {
    // no-store: sengaja gak mau kena cache SAAT NGECEK — kalau request
    // pengecekan ini sendiri kena cache lama, ya gak akan pernah ketauan
    // ada versi baru. Ini satu-satunya fetch yang harus selalu fresh.
    const res = await fetch(`/index.html?_check=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<meta\s+name="app-build"\s+content="([^"]+)"/i);
    if (!match) return null;
    return match[1];
  } catch (_) {
    // Offline / network error saat polling — jangan ganggu user dengan
    // error, cukup anggap "belum tau ada update atau tidak" kali ini.
    return null;
  }
}