import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchGate, verifyBypass, readBypassToday, saveBypassToday } from './stockGate.js';

const POLL_MS = 15000;

/**
 * useStockGate(enabled) — status gate Absen Pulang.
 *   gateOpen   : true kalau Stok Belanja sudah disimpan di Mamam POS, atau kode bypass owner sudah dipakai.
 *   bypassed   : gate terbuka karena kode bypass (bukan karena stok disimpan).
 *   loading    : pengecekan pertama belum selesai (gate dianggap tertutup).
 *   error      : pesan kalau server tidak terjangkau (gate tertutup, ada tombol coba lagi).
 *   recheck()  : cek ulang SEKARANG (dipakai saat menekan Catat Absen); true = boleh pulang.
 *   tryBypass(code) : verifikasi kode; true = terbuka. Melempar error dengan pesan yang bisa ditampilkan.
 * Selama gate tertutup dan layar terlihat, dicek ulang tiap 15 detik dan saat tab kembali aktif, jadi karyawan
 * yang menunggu langsung tahu begitu stok disimpan di POS (tanpa realtime).
 */
export function useStockGate(enabled = true) {
  // serverOpen mulai true (optimistis): gate baru dianggap tertutup setelah server menjawab. Catat Absen tetap memanggil recheck().
  const [state, setState] = useState({ serverOpen: true, notReady: false, loading: false, error: '', checked: false });
  const [bypassed, setBypassed] = useState(() => readBypassToday());
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (busy.current) return null;
    busy.current = true;
    try {
      const r = await fetchGate();
      setState({ serverOpen: r.open, notReady: r.notReady, loading: false, error: '', checked: true });
      return r.open;
    } catch (e) {
      console.error('Gagal mengecek Stok Belanja:', e);
      setState((s) => ({ ...s, serverOpen: false, loading: false, error: 'Gagal mengecek Stok Belanja. Periksa koneksi internet.', checked: true }));
      return false;
    } finally { busy.current = false; }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setState((s) => (s.checked ? s : { ...s, loading: true }));
    check();
  }, [enabled, check]);

  const open = state.serverOpen || bypassed;
  useEffect(() => {
    if (!enabled || open) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') check(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, open, check]);

  const recheck = useCallback(async () => {
    if (bypassed) return true;
    busy.current = false;      // permintaan yang sedang jalan mungkin basi: paksa cek baru
    return Boolean(await check());
  }, [bypassed, check]);

  const tryBypass = useCallback(async (code) => {
    const ok = await verifyBypass(code);
    if (ok) { saveBypassToday(); setBypassed(true); }
    return ok;
  }, []);

  return {
    gateOpen: open, bypassed: bypassed && !state.serverOpen, loading: state.loading && !bypassed,
    error: bypassed ? '' : state.error, refresh: check, recheck, tryBypass,
  };
}
