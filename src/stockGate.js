// ── Gate "Absen Pulang" (Stok Belanja ada di Mamam POS) ───────────────────────
//
// Absen pulang dikunci sampai Stok Belanja hari ini DISIMPAN di Mamam POS. Web ini tidak lagi mengisi/menampilkan
// stok; ia hanya bertanya ke dua fungsi di database (project yang sama dengan mamam-pos, migrasi 021):
//   - stok_gate_terbuka()    -> true kalau hasil stok hari ini sudah disimpan (atau tidak ada item wajib)
//   - stok_bypass_cek(kode)  -> true kalau kode 6 digit dari owner benar (berganti tiap 30 detik)
// Ini pagar alur kerja (seperti cek GPS), bukan keamanan data.

import { supabase, isConfigured } from './supabase.js';

// Hari bisnis mulai 04.00 WIB (sama dengan stok_hari_bisnis() di database): tanggal WIB dikurangi 4 jam = tanggal UTC dari (sekarang + 3 jam).
export function businessDate(now = new Date()) {
  return new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

// Fungsi database belum dibuat (migrasi 021 belum dijalankan): fitur dianggap belum aktif, absen pulang tidak dikunci.
export function isMissingFunction(error) {
  return Boolean(error) && (
    error.code === 'PGRST202' || error.code === '42883' ||
    /could not find the function|function .* does not exist/i.test(error.message || '')
  );
}

// Hasil: { open: boolean, notReady: boolean }. Melempar error kalau jaringan/server bermasalah.
export async function fetchGate() {
  if (!isConfigured()) return { open: true, notReady: true };
  const { data, error } = await supabase.rpc('stok_gate_terbuka');
  if (error) {
    if (isMissingFunction(error)) return { open: true, notReady: true };
    throw error;
  }
  return { open: data === true, notReady: false };
}

// true = kode benar. Melempar error (mis. "Terlalu banyak percobaan") supaya pesannya bisa ditampilkan.
export async function verifyBypass(code) {
  const { data, error } = await supabase.rpc('stok_bypass_cek', { p_kode: String(code || '') });
  if (error) throw error;
  return data === true;
}

// Kode yang sudah terbukti benar diingat di HP ini sampai ganti hari bisnis, supaya refresh halaman
// tidak minta kode lagi. Tidak menyimpan kodenya, hanya tanggalnya.
const BYPASS_KEY = 'mamam-absensi-stok-bypass';
export function readBypassToday(storage = globalThis.localStorage) {
  try { return storage?.getItem(BYPASS_KEY) === businessDate(); } catch { return false; }
}
export function saveBypassToday(storage = globalThis.localStorage) {
  try { storage?.setItem(BYPASS_KEY, businessDate()); } catch { /* storage diblokir: berlaku sampai halaman ditutup */ }
}
