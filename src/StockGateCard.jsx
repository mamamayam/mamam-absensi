import { useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2 } from 'lucide-react';

/**
 * Kartu gate Absen Pulang. Hanya peringatan teks (tanpa tautan ke Mamam POS) dan kolom kode bypass dari owner.
 * Tidak tampil kalau gate terbuka karena stok sudah disimpan (notif "sudah terbuka" ada di App.jsx).
 */
export default function StockGateCard({ gate }) {
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (gate.loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-stone-400 mb-3">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Mengecek Stok Belanja...
      </div>
    );
  }

  if (gate.gateOpen) {
    if (!gate.bypassed) return null;
    return (
      <div className="flex items-center gap-2.5 bg-green-50 border border-green-200 rounded-xl px-3.5 py-3 mb-3">
        <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
        <p className="text-xs text-green-700 font-medium leading-relaxed">Absen pulang dibuka dengan kode bypass owner.</p>
      </div>
    );
  }

  const submit = async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setErr('');
    try {
      const ok = await gate.tryBypass(code);
      if (!ok) setErr('Kode salah atau sudah kedaluwarsa. Minta kode terbaru ke owner.');
    } catch (e) {
      setErr(e?.message || 'Gagal memeriksa kode. Coba lagi.');
    } finally { setBusy(false); }
  };

  return (
    <div className="mb-4 space-y-2.5" data-testid="stock-gate-card">
      <div className="flex items-center gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
        <p className="text-xs text-amber-700 font-medium leading-relaxed">
          Buka Mamam POS dan isi Stok Belanja sampai selesai sebelum absen pulang.
        </p>
      </div>

      {gate.error && (
        <div className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 rounded-xl px-3.5 py-2.5">
          <p className="text-xs text-red-600 font-medium">{gate.error}</p>
          <button type="button" onClick={gate.refresh} className="text-xs font-bold text-red-700 underline shrink-0">Coba lagi</button>
        </div>
      )}

      {!showCode ? (
        <button type="button" onClick={() => setShowCode(true)} className="flex items-center gap-1.5 text-xs text-stone-500 underline mx-auto">
          <KeyRound className="w-3.5 h-3.5" /> Punya kode bypass dari owner?
        </button>
      ) : (
        <div>
          <div className="flex gap-2">
            <input
              inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="••••••" value={code} aria-label="Kode bypass"
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              className="flex-1 min-w-0 border border-stone-200 rounded-xl px-4 py-2.5 text-center font-mono text-lg tracking-[0.3em] focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <button
              type="button" onClick={submit} disabled={code.length !== 6 || busy}
              className="px-5 rounded-xl bg-orange-600 disabled:bg-stone-200 disabled:text-stone-400 text-white text-sm font-bold"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Pakai'}
            </button>
          </div>
          {err && <p className="text-xs text-red-600 mt-1.5">{err}</p>}
        </div>
      )}
    </div>
  );
}
