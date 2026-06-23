-- =========================================================================
-- MAMAM KASIR — Migrasi tambahan #2: storage bucket buat foto selfie absen
-- Jalankan SEKALI di Supabase SQL Editor (project yang sama).
--
-- Foto sengaja TIDAK disimpan sebagai base64 di kolom jsonb (boncos kuota
-- database free tier) — disimpan di Supabase Storage (kuota terpisah, 1GB
-- di free tier), tabel attendanceLog cuma nyimpen URL-nya (string pendek).
-- =========================================================================

insert into storage.buckets (id, name, public)
values ('attendance-photos', 'attendance-photos', true)
on conflict (id) do nothing;

-- Siapa aja (termasuk anon) boleh baca foto — perlu, karena admin app utama
-- nampilin foto ini dari publicUrl tanpa login.
drop policy if exists "attendance_photos_public_read" on storage.objects;
create policy "attendance_photos_public_read"
on storage.objects for select
to public
using (bucket_id = 'attendance-photos');

-- Siapa aja (anon) boleh upload — web absen karyawan gak pakai Supabase Auth,
-- sama persis seperti tabel lain yang juga anon-write.
drop policy if exists "attendance_photos_anon_upload" on storage.objects;
create policy "attendance_photos_anon_upload"
on storage.objects for insert
to anon
with check (bucket_id = 'attendance-photos');
