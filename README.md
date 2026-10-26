# mamam-absensi

Web ringan untuk karyawan absen masuk/pulang dari HP masing-masing: pilih nama, foto selfie, verifikasi lokasi GPS
(absen tetap tersimpan walau jauh dari outlet, hanya ditandai `flagged`), dan isi checklist stok sebelum absen pulang.

## Satu project dengan mamam-pos

Web ini memakai **project Supabase yang sama dengan mamam-pos** (project C). mamam-global sudah dimatikan.

| Data | Lokasi |
|---|---|
| Daftar karyawan | fungsi `absen_daftar_karyawan()` (dari tabel `employees`; diurus di layar **Karyawan** mamam-pos) |
| Log absen | tabel `attendance_log` |
| Foto selfie | bucket `attendance-photos` |
| Checklist stok | tabel `stock_checklists`, master di `app_settings` (key `stockMaster`) |

Ganti karyawan: cukup di mamam-pos (status karyawan lama jadi `resign`, tambah yang baru). Namanya otomatis ikut di sini.

Skema database ada di repo mamam-pos: `supabase/migrations/020_absensi.sql` (jalankan di SQL Editor project C).
Langkah pindah dari project lama dan cutover: `docs/migrasi-absensi.md` di repo mamam-pos.

## Setup

1. Copy `.env.example` jadi `.env.local`, isi dengan kunci **project C** (Dashboard > Project Settings > API, kunci anon/publishable):
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   - `VITE_OUTLET_LAT`, `VITE_OUTLET_LNG` — koordinat outlet (klik kanan di Google Maps)
   - `VITE_OUTLET_RADIUS_M` — radius toleransi GPS dalam meter
2. `npm install` lalu `npm run dev` (buka `http://localhost:5173`).

## Deploy (Vercel)

Import repo ini di Vercel (otomatis terdeteksi sebagai project Vite), isi Environment Variables yang sama dengan `.env.example`, deploy.
Mengganti project Supabase = ganti `VITE_SUPABASE_URL` dan `VITE_SUPABASE_ANON_KEY` lalu redeploy.
