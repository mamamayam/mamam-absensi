import { createClient } from '@supabase/supabase-js';

// Diisi lewat Environment Variables di dashboard Vercel (atau file .env saat
// development lokal — lihat .env.example). SAMA PERSIS dengan project
// Supabase yang dipakai app Mamam Kasir utama, biar data nyambung.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

export const isConfigured = () => Boolean(supabase);
