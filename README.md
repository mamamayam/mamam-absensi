# mamam-absensi

Web ringan untuk karyawan absen masuk/pulang dari HP masing-masing: pilih nama, foto selfie, verifikasi lokasi GPS
(absen tetap tersimpan walau jauh dari outlet, hanya ditandai `flagged`). Absen pulang dikunci sampai Stok Belanja diisi di Mamam POS.

## Satu project dengan mamam-pos

Web ini memakai **project Supabase yang sama dengan mamam-pos** (project C). mamam-global sudah dimatikan.

| Data | Lokasi |
|---|---|
| Daftar karyawan | fungsi `absen_daftar_karyawan()` (dari tabel `employees`; diurus di layar **Karyawan** mamam-pos) |
| Log absen | tabel `attendance_log` |
| Foto selfie | bucket `attendance-photos` |
| Gate Absen Pulang (Stok Belanja) | fungsi `stok_gate_terbuka()` dan `stok_bypass_cek(kode)`; stoknya sendiri diisi dan dikelola di **Stok Belanja** mamam-pos (tabel `stock_*`) |

Ganti karyawan: cukup di mamam-pos (status karyawan lama jadi `resign`, tambah yang baru). Namanya otomatis ikut di sini.

Skema database ada di repo mamam-pos: `supabase/migrations/020_absensi.sql` dan `021_stok_belanja.sql` (jalankan di SQL Editor project C).
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

## Absen pulang dan Stok Belanja

Tombol **Pulang** terkunci sampai hasil Stok Belanja hari itu disimpan di Mamam POS oleh siapa pun (staf mengisi, tab Isi).
Web ini hanya menampilkan peringatan dan mengecek status tiap 15 detik; tidak ada tautan ke POS.
Darurat: owner melihat **kode bypass** 6 digit (berganti tiap 30 detik) di Mamam POS > Stok Belanja > Isi. Karyawan memasukkannya di
kartu peringatan ("Punya kode bypass dari owner?") dan Pulang terbuka di HP itu sampai ganti hari bisnis (04.00 WIB).
Kalau fungsi database belum dibuat (migrasi 021 belum dijalankan), absen pulang tidak dikunci. Kalau server tidak terjangkau, tetap terkunci dengan tombol Coba lagi.
Ini pagar alur kerja (seperti cek GPS), bukan keamanan data.
