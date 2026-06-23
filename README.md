<<<<<<< HEAD
# Absensi Karyawan — Mamam Ayam

Web ringan buat karyawan absen masuk/pulang dari HP masing-masing. Terpisah
dari app Mamam Kasir utama, tapi konek ke project Supabase yang sama, jadi
absen yang masuk di sini langsung muncul di menu **Absensi Karyawan** app
utama (lewat realtime sync yang sudah ada).

## Cara kerja singkat

1. Kasir/owner buka menu **Absensi Karyawan** di app Mamam Kasir → muncul
   kode 6 digit yang berganti tiap 30 detik.
2. Karyawan buka link web ini di HP sendiri, pilih nama → masukkan kode →
   foto selfie → verifikasi lokasi GPS.
3. Sistem otomatis tahu ini absen masuk atau pulang (lihat riwayat hari ini),
   tapi karyawan juga bisa pilih manual lewat toggle di atas.
4. Kalau lokasi GPS jauh dari outlet, absen TETAP tersimpan — cuma ditandai
   `flagged` buat ditinjau admin, gak diblokir (biar karyawan gak gagal absen
   gara-gara GPS HP-nya kurang akurat).

## Setup awal (sekali saja)

1. Jalankan migrasi `supabase_schema_attendance.sql` (kalau belum) dan
   `supabase_schema_attendance_storage.sql` di Supabase SQL Editor, project
   yang sama dengan app utama. Yang kedua ini bikin storage bucket buat
   foto selfie.
2. Copy `.env.example` jadi `.env`, isi:
   - `VITE_SUPABASE_URL` & `VITE_SUPABASE_ANON_KEY` — dari Supabase Dashboard
     > Project Settings > API (sama dengan app utama)
   - `VITE_OUTLET_LAT` & `VITE_OUTLET_LNG` — koordinat outlet asli. Ambil dari
     Google Maps: klik kanan di lokasi outlet, klik angka koordinat yang
     muncul.
   - `VITE_OUTLET_RADIUS_M` — radius toleransi GPS dalam meter (default 100m)

## Jalankan lokal

```bash
npm install
npm run dev
```

Buka `http://localhost:5173`.

## Deploy ke Vercel

1. Push folder ini ke repo GitHub (terpisah dari repo app utama).
2. Di [vercel.com](https://vercel.com) → **Add New Project** → import repo
   ini. Vercel otomatis kedeteksi sebagai project Vite, gak perlu ubah
   build settings.
3. Sebelum deploy, buka **Settings > Environment Variables**, tambahkan
   ke-5 variable yang ada di `.env.example`.
4. Deploy. Setelah online, copy URL-nya (mis. `https://absen-mamam-ayam.vercel.app`)
   dan tempel ke konstanta `ATTENDANCE_WEB_URL` di file
   `features/hrd/Attendance.jsx` pada app Mamam Kasir utama.

## Yang belum ada di versi ini

- Lock multi-device untuk kode OTP (kalau ada 2 layar kasir buka bersamaan,
  masing-masing generate kode sendiri).
- Kompresi foto cuma di sisi browser (canvas) — kalau HP karyawan jadul
  banget, proses kompres bisa agak lambat, tapi tetap jalan.
=======
# mamam-absensi
>>>>>>> f4fd87ee7825c5395171b2a0d7ace0981a294015
