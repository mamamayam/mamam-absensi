// ── Stock Checklist ────────────────────────────────────────────────────────
//
// Struktur data:
//  - Master kategori & item → disimpan di Supabase, tabel "app_config",
//    row dengan key = 'stockMaster', kolom value (JSONB) = { categories: [...] }.
//    Ini SINKRON ke semua device (laptop admin, HP kasir, dll) dan otomatis
//    ter-update di device lain lewat Supabase Realtime (lihat subscribeStockMaster).
//    localStorage ("stockMaster_v1") dipakai HANYA sebagai cache lokal untuk
//    tampilan awal secepatnya sebelum data dari server datang, dan sebagai
//    fallback kalau device sedang offline / gagal konek.
//  - Checklist harian → disimpan di Supabase, tabel "stock_checklists",
//    row per key (biasanya = tanggal). Kolom: values (JSONB, { [itemId]:
//    { qty, skipped } }), category_done (JSONB, { [categoryId]: true }),
//    submitted_at, submitted_by, shared_at, locked.
//    SINKRON real-time antar device (lihat subscribeStockChecklist) supaya
//    karyawan bisa bagi tugas isi form checklist di HP masing-masing.
//    localStorage ("stockChecklist_<key>") dipakai HANYA sebagai cache lokal,
//    sama polanya seperti stockMaster.
//
// Granularitas push: BUKAN per-keystroke/per-item lagi (dulu begitu, bikin
// glitch pas ngetik angka panjang karena tiap karakter push ke server).
// Sekarang push dilakukan PER KATEGORI: karyawan isi semua item dalam satu
// kategori di form lokal (state React biasa, belum ke server), baru pas
// tekan "Selesai" kategori itu, SEMUA item dalam kategori itu di-push
// sekaligus lewat satu RPC atomic (completeCategory) + kategori itu ditandai
// done=true. Device lain langsung lihat kategori itu berubah jadi selesai
// lewat realtime, tanpa perlu tau isian detailnya real-time per-karakter.
//
// "key" biasanya sama dengan dateStr (YYYY-MM-DD) hari checklist itu dibuat,
// tapi kalau checklist belum dibagikan ke WhatsApp, dia TIDAK dihapus/direset
// walau sudah ganti hari — checklist lama itu yang tetap jadi checklist aktif
// sampai ada yang menekan "Bagikan ke WhatsApp".
//
// Locking: begitu SATU karyawan menekan "Bagikan ke WhatsApp" dan berhasil
// tersimpan sebagai locked=true di server, checklist itu terkunci untuk
// SEMUA device (lihat isChecklistLocked). Device lain yang masih membuka
// form yang sama akan otomatis melihatnya sebagai "sudah dibagikan" lewat
// realtime subscribe, dan gate absen pulang ikut kebuka di semua device.
// Form checklist TETAP tertutup (locked) sampai ganti hari, walau layar
// di-refresh berkali-kali — lihat loadActiveChecklistFromServer &
// findActiveUnlockedChecklistCache.

import { getTodayStr } from './utils.js';

const MASTER_KEY = 'stockMaster_v1';
const CHECKLIST_PREFIX = 'stockChecklist_';
const STOCK_MASTER_CONFIG_KEY = 'stockMaster';
const CHECKLIST_TABLE = 'stock_checklists';

export function generateStockId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'sid-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

// ── Master kategori & item (Supabase, sinkron semua device) ────────────────
const DEFAULT_MASTER = { categories: [] };

function loadMasterFromCache() {
  try {
    const raw = localStorage.getItem(MASTER_KEY);
    if (!raw) return DEFAULT_MASTER;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.categories)) return DEFAULT_MASTER;
    return parsed;
  } catch (_) {
    return DEFAULT_MASTER;
  }
}

function saveMasterToCache(master) {
  try {
    localStorage.setItem(MASTER_KEY, JSON.stringify(master));
  } catch (_) {
    // localStorage penuh/disabled — bukan masalah besar, Supabase tetap sumber utama
  }
}

// Ambil master dari Supabase. `supabase` adalah client yang sudah diinisialisasi
// (import dari './supabase.js' di pemanggil), supaya file ini tidak membuat
// client sendiri / tidak duplikat konfigurasi.
//
// Selalu balikin cache localStorage dulu (instan), lalu caller sebaiknya
// menimpa dengan hasil Supabase begitu datang — lihat StockChecklist.jsx.
export function loadMasterCached() {
  return loadMasterFromCache();
}

export async function loadMasterFromServer(supabase) {
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', STOCK_MASTER_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const value = data?.value;
  if (!value || !Array.isArray(value?.categories)) {
    return DEFAULT_MASTER;
  }
  saveMasterToCache(value);
  return value;
}

// Simpan master ke Supabase (upsert by key) + update cache lokal.
// Fire-and-forget di sisi caller (UI sudah optimistic-update duluan lewat
// setMaster lokal); kalau gagal, dilempar supaya caller bisa kasih tau user.
export async function saveMasterToServer(supabase, master) {
  saveMasterToCache(master); // optimistic: cache lokal langsung update
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: STOCK_MASTER_CONFIG_KEY, value: master }, { onConflict: 'key' });

  if (error) {
    throw error;
  }
  return master;
}

// Subscribe ke perubahan row stockMaster di app_config lewat Supabase Realtime.
// onRemoteChange(newMaster) dipanggil setiap ada perubahan dari device lain.
// onResync (opsional) dipanggil setiap channel berhasil (re)connect — termasuk
// SETIAP KALI setelah koneksi realtime sempat putus-nyambung (misal wifi
// goyang) — supaya device bisa re-fetch dari server dan tidak kehilangan
// perubahan yang terjadi PERSIS selama jendela waktu terputus (postgres_changes
// cuma mengirim event yang terjadi SAAT channel aktif, tidak ada replay
// otomatis untuk backlog kejadian saat disconnect).
// Balikin fungsi unsubscribe untuk dipanggil di cleanup useEffect.
export function subscribeStockMaster(supabase, onRemoteChange, onResync) {
  const channel = supabase
    .channel('stock-master-changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'app_config', filter: `key=eq.${STOCK_MASTER_CONFIG_KEY}` },
      (payload) => {
        const value = payload.new?.value;
        if (value && Array.isArray(value.categories)) {
          saveMasterToCache(value);
          onRemoteChange(value);
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED' && typeof onResync === 'function') {
        onResync();
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}

// ── Fungsi mutator di bawah ini semuanya PURE (hanya menghitung `next`,
// TIDAK menyimpan apa-apa). Setelah dapat `next`, caller (StockChecklist.jsx)
// wajib panggil saveMasterToServer(supabase, next) sendiri untuk benar-benar
// menyimpannya ke Supabase + cache lokal. Ini supaya file ini tidak perlu tahu
// soal koneksi Supabase, dan supaya caller bisa kasih feedback loading/error
// ke user saat proses simpan berlangsung.

export function addCategory(master, name) {
  const next = {
    ...master,
    categories: [...master.categories, { id: generateStockId(), name, items: [] }],
  };
  return next;
}

export function renameCategory(master, categoryId, name) {
  const next = {
    ...master,
    categories: master.categories.map((c) => (c.id === categoryId ? { ...c, name } : c)),
  };
  return next;
}

export function deleteCategory(master, categoryId) {
  const next = { ...master, categories: master.categories.filter((c) => c.id !== categoryId) };
  return next;
}

export function addItem(master, categoryId, { name, unit, required }) {
  const next = {
    ...master,
    categories: master.categories.map((c) =>
      c.id === categoryId
        ? { ...c, items: [...c.items, { id: generateStockId(), name, unit, required: !!required }] }
        : c
    ),
  };
  return next;
}

export function updateItem(master, categoryId, itemId, patch) {
  const next = {
    ...master,
    categories: master.categories.map((c) =>
      c.id === categoryId
        ? { ...c, items: c.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) }
        : c
    ),
  };
  return next;
}

export function deleteItem(master, categoryId, itemId) {
  const next = {
    ...master,
    categories: master.categories.map((c) =>
      c.id === categoryId ? { ...c, items: c.items.filter((it) => it.id !== itemId) } : c
    ),
  };
  return next;
}

// Pindahin satu kategori dari posisi fromIndex ke toIndex (drag reorder kategori).
export function reorderCategory(master, fromIndex, toIndex) {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= master.categories.length ||
    toIndex >= master.categories.length
  ) {
    return master;
  }
  const cats = [...master.categories];
  const [moved] = cats.splice(fromIndex, 1);
  cats.splice(toIndex, 0, moved);
  const next = { ...master, categories: cats };
  return next;
}

// Pindahin satu item dalam kategori dari posisi fromIndex ke toIndex (drag reorder item).
export function reorderItem(master, categoryId, fromIndex, toIndex) {
  const cat = master.categories.find((c) => c.id === categoryId);
  if (!cat) return master;
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= cat.items.length ||
    toIndex >= cat.items.length
  ) {
    return master;
  }
  const items = [...cat.items];
  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved);
  const next = {
    ...master,
    categories: master.categories.map((c) => (c.id === categoryId ? { ...c, items } : c)),
  };
  return next;
}

// Pindahin satu item dari kategori asal ke kategori tujuan (ditaruh di akhir list
// kategori tujuan). Kalau kategori asal == tujuan, gak ngapa-ngapain.
export function moveItemToCategory(master, fromCategoryId, itemId, toCategoryId) {
  if (fromCategoryId === toCategoryId) return master;
  const fromCat = master.categories.find((c) => c.id === fromCategoryId);
  const toCat = master.categories.find((c) => c.id === toCategoryId);
  if (!fromCat || !toCat) return master;
  const item = fromCat.items.find((it) => it.id === itemId);
  if (!item) return master;

  const next = {
    ...master,
    categories: master.categories.map((c) => {
      if (c.id === fromCategoryId) {
        return { ...c, items: c.items.filter((it) => it.id !== itemId) };
      }
      if (c.id === toCategoryId) {
        return { ...c, items: [...c.items, item] };
      }
      return c;
    }),
  };
  return next;
}

export function allItemsFlat(master) {
  const out = [];
  for (const cat of master.categories) {
    for (const it of cat.items) {
      out.push({ ...it, categoryId: cat.id, categoryName: cat.name });
    }
  }
  return out;
}

// Data awal (seed) sesuai daftar stok fisik yang ditempel di outlet.
// Semua item dibuat OPSIONAL dulu — silakan tandai WAJIB, pindah kategori,
// ubah nama/satuan, atau hapus lewat panel "Kelola Kategori & Item".
const SEED_DATA = [
  {
    name: 'Bahan Minuman',
    items: [
      'Nutrisari Mango', 'Nutrisari Strawberry', 'White Coffee', 'Milo',
      'Susu Kental Manis', 'UHT', 'Yakult', 'Oreo', 'Es Batu',
      'Sedotan Besar', 'Sedotan Kecil', 'Cup', 'Plastik Cup Single',
      'Plastik Cup Double', 'Air Galon', 'Plastik 24', 'Plastik 28',
      'Plastik Besar', 'Sendok', 'Plastik Sendok', 'Plastik Saos',
      'Sarung Tangan Plastik', 'Saos Sachet', 'Lakban Bening',
      'Lakban Gofood', 'Lakban Grabfood', 'Lakban Shopeefood',
      'Stiker M', 'Stiker L', 'Stiker Wings', 'Gas', 'Sterofoam Seblak',
    ],
  },
  {
    name: 'Meja Besar',
    items: [
      'Ricebox L', 'Ricebox M', 'Lunchbox L', 'Lunchbox M', 'Kertas Nasi',
      'Bon Nori', 'Bon Cabe', 'Wijen', 'Minyak', 'Garam', 'Tali Ripet',
      'Plastik 17',
    ],
  },
  {
    name: 'Kulkas',
    items: [
      'Sambal Matah', 'Sambal Geprek', 'Aqua', 'Teh Pucuk', 'Firesauce',
      'Brownbutter', 'Mentai',
    ],
  },
];

export function seedDefaultStock() {
  let master = DEFAULT_MASTER;
  for (const cat of SEED_DATA) {
    master = addCategory(master, cat.name);
    const catId = master.categories[master.categories.length - 1].id;
    for (const itemName of cat.items) {
      master = addItem(master, catId, { name: itemName, unit: '', required: false });
    }
  }
  return master;
}

// ── Checklist harian (Supabase, sinkron semua device) ──────────────────────
function checklistStorageKey(key) {
  return CHECKLIST_PREFIX + key;
}

function emptyChecklist(key, dateStr) {
  return {
    key,
    dateStr,
    values: {},
    categoryDone: {},
    submittedAt: null,
    submittedBy: null,
    sharedAt: null,
    locked: false,
    // Checklist sintetis yang belum pernah disimpan ke server — dikasih
    // timestamp client "sekarang" supaya kalau ada respons server yang lebih
    // lama (misal fetch basi) datang belakangan, dia tetap dianggap tidak
    // lebih baru dari checklist kosong ini dan tidak menimpanya sembarangan
    // (lihat pickNewerChecklist).
    updatedAt: new Date().toISOString(),
  };
}

// Konversi row Supabase (snake_case) <-> bentuk lokal (camelCase) yang dipakai UI.
// Kolom JSONB (values, category_done) NORMALNYA sudah jadi object JS begitu
// diterima dari supabase-js, tapi payload realtime (postgres_changes) di
// beberapa kondisi mengirimkannya sebagai STRING JSON mentah, bukan object
// yang sudah di-parse. Kalau tidak diantisipasi, `row.category_done || {}`
// akan menganggap string itu truthy dan memakainya apa adanya (bukan {}),
// sehingga `checklist.categoryDone?.[id]` selalu undefined walau datanya
// sebenarnya ada — inilah sumber bug "kategori sudah ditandai selesai di
// server tapi device lain masih lihat belum selesai". Fungsi ini selalu
// memastikan hasil akhirnya adalah OBJECT, entah dari object langsung atau
// dari string yang perlu di-JSON.parse dulu.
export function parseJsonbField(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

export function rowToChecklist(row) {
  return {
    key: row.key,
    dateStr: row.date_str,
    values: parseJsonbField(row.values, {}),
    categoryDone: parseJsonbField(row.category_done, {}),
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by ?? null,
    sharedAt: row.shared_at,
    locked: !!row.locked,
    updatedAt: row.updated_at ?? null,
  };
}

<<<<<<< HEAD
// ============================================================================
// PENJAGA RACE CONDITION: "data lebih baru tidak boleh pernah ketiban data
// lebih lama".
// ============================================================================
// Checklist bisa datang dari BANYAK sumber async yang berjalan bersamaan:
// fetch awal, realtime event, reconcile tiap reconnect (onResync), dan hasil
// RPC dari aksi user sendiri (completeCategory/reopenCategory/submit/share).
// Semuanya sama-sama network call yang durasinya TIDAK terjamin — sebuah
// fetch yang MULAI duluan bisa saja SELESAI belakangan (misal koneksi lagi
// lambat), dan kalau hasilnya langsung ditimpakan begitu saja ke state tanpa
// dicek, dia bisa menimpa balik state yang sebenarnya sudah lebih baru
// (misal user baru saja menyelesaikan kategori terakhir SAAT fetch lama itu
// masih berjalan di background) — hasilnya: isian yang sudah lengkap
// mendadak "hilang" dari state, padahal di server datanya aman.
//
// pickNewerChecklist() adalah SATU-SATUNYA pintu masuk yang boleh dipakai
// untuk mengganti state checklist dari sumber manapun (kecuali optimistic
// update lokal yang murni derivasi dari state saat ini, itu aman tanpa perlu
// dicek). Aturan: kalau key beda, itu checklist yang berbeda sama sekali
// (bukan soal timing) — langsung terima. Kalau key sama, cuma terima kalau
// updatedAt versi baru >= yang sedang ada. Kalau salah satu tidak punya
// updatedAt (data lama / edge case), anggap aman untuk diterima (fail-open,
// supaya tidak ada state yang "macet" gara-gara metadata hilang).
export function pickNewerChecklist(incoming, current) {
  if (!incoming) return current;
  if (!current || !current.key) return incoming;
  if (incoming.key !== current.key) return incoming;
  if (!incoming.updatedAt || !current.updatedAt) return incoming;
  return new Date(incoming.updatedAt) >= new Date(current.updatedAt) ? incoming : current;
}

=======
>>>>>>> 3ef75f7502957a26c60efc5ad53edb35e5cb20e2
function loadChecklistCacheByKey(key) {
  try {
    const raw = localStorage.getItem(checklistStorageKey(key));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function saveChecklistCache(checklist) {
  try {
    localStorage.setItem(checklistStorageKey(checklist.key), JSON.stringify(checklist));
  } catch (_) {
    // localStorage penuh/disabled — bukan masalah besar, Supabase tetap sumber utama
  }
}

// Cari cache lokal checklist yang UNLOCKED (belum di-share ke WA) — dipakai
// untuk carry-over instan kalau belum ada cache khusus untuk hari ini (misal
// checklist kemarin belum sempat dibagikan, dan device ini baru dibuka lagi
// hari ini SEBELUM data server sempat datang). Kalau ada beberapa entry
// unlocked (seharusnya jarang terjadi), ambil yang dateStr paling lama —
// itu yang paling mungkin jadi checklist aktif yang sedang berjalan.
function findActiveUnlockedChecklistCache() {
  let found = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(CHECKLIST_PREFIX)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(k));
      if (parsed && parsed.locked === false) {
        if (!found || (parsed.dateStr && found.dateStr && parsed.dateStr < found.dateStr)) {
          found = parsed;
        }
      }
    } catch (_) {
      // abaikan entry rusak
    }
  }
  return found;
}

// Cache lokal instan (dipakai sebagai initial state sebelum Supabase datang),
// sama pola seperti loadMasterCached(). Urutan prioritas:
// 1. Cache untuk key = hari ini, APAPUN statusnya (locked atau belum) — ini
//    yang paling relevan dan paling akurat untuk device ini secara instan.
// 2. Kalau belum ada cache untuk hari ini (device baru pertama kali dibuka
//    hari ini di device ini), cari checklist unlocked dari hari sebelumnya
//    yang masih carry-over (belum di-share) — supaya TIDAK sempat flash
//    "form kosong" sesaat sebelum data server konfirmasi checklist mana
//    yang sebenarnya aktif.
// 3. Kalau benar-benar tidak ada cache relevan sama sekali → checklist baru
//    kosong untuk hari ini (akan dikoreksi begitu server merespons kalau
//    ternyata ada checklist aktif yang berbeda).
export function loadChecklistCached() {
  const todayStr = getTodayStr();
  const todayCache = loadChecklistCacheByKey(todayStr);
  if (todayCache) return todayCache;

  const carryOver = findActiveUnlockedChecklistCache();
  if (carryOver) return carryOver;

  return emptyChecklist(todayStr, todayStr);
}

// Ambil checklist aktif dari Supabase:
// 1. Kalau ada row locked=false yang PALING LAMA (belum di-share ke WA) →
//    itu checklist aktif, walau `submitted_at` masih null (di model per-kategori,
//    checklist bisa aktif & ada isian tanpa submitted_at terisi — submitted_at
//    cuma keisi saat form KESELURUHAN ditekan "Selesai Isi Checklist").
//    Ini juga otomatis carry-over checklist kemarin yang belum dibagikan,
//    walau sudah ganti hari — sesuai aturan: checklist TIDAK reset sampai
//    ada yang menekan "Bagikan ke WhatsApp".
// 2. Kalau tidak ada row locked=false sama sekali → berarti checklist hari
//    ini (kalau ada) sudah di-share/locked, atau belum ada row sama sekali →
//    buat checklist baru dengan key = todayStr.
export async function loadActiveChecklistFromServer(supabase) {
  const { data: activeRows, error: activeErr } = await supabase
    .from(CHECKLIST_TABLE)
    .select('*')
    .eq('locked', false)
    .order('date_str', { ascending: true })
    .limit(1);

  if (activeErr) throw activeErr;

  if (activeRows && activeRows.length > 0) {
    const checklist = rowToChecklist(activeRows[0]);
    saveChecklistCache(checklist);
    return checklist;
  }

  // Tidak ada row locked=false sama sekali → checklist hari ini (kalau ada)
  // sudah dibagikan, atau memang belum pernah ada row → mulai checklist baru.
  const todayStr = getTodayStr();
  const key = todayStr;
  const fresh = emptyChecklist(key, todayStr);
  saveChecklistCache(fresh);
  return fresh;
}

// Subscribe ke perubahan tabel stock_checklists lewat Supabase Realtime, supaya
// begitu satu HP menyelesaikan satu kategori, HP lain yang buka checklist yang
// sama (key sama) langsung lihat progressnya tanpa reload.
// onResync (opsional) — lihat penjelasan lengkap di subscribeStockMaster di atas;
// prinsip sama persis, cuma diterapkan ke channel checklist ini.
// Balikin fungsi unsubscribe.
export function subscribeStockChecklist(supabase, activeKey, onRemoteChange, onResync) {
  const channel = supabase
    .channel(`stock-checklist-${activeKey}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: CHECKLIST_TABLE, filter: `key=eq.${activeKey}` },
      (payload) => {
        if (!payload.new) return;
        const checklist = rowToChecklist(payload.new);
        saveChecklistCache(checklist);
        onRemoteChange(checklist);
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED' && typeof onResync === 'function') {
        onResync();
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}

// CATATAN: dulu ada fungsi saveChecklistToServer() di sini yang upsert SELURUH
// row (termasuk kolom `values`) dari snapshot state lokal caller. Itu sumber
// race condition: kalau device lain baru saja menambah isian yang belum sempat
// di-refresh ke state lokal device ini, upsert seluruh row akan MENIMPA isian
// device lain itu jadi hilang. Sudah dihapus — semua mutasi checklist sekarang
// WAJIB lewat RPC (complete_stock_checklist_category / reopen_stock_checklist_category /
// submit_stock_checklist / share_stock_checklist di bawah) yang cuma meng-update
// kolom spesifik yang relevan di server, bukan replace seluruh row dari state
// lokal yang mungkin basi.

// Tandai SATU kategori sebagai "selesai diisi", push semua isian item dalam
// kategori itu SEKALIGUS (satu RPC atomic completeCategory), bukan per-item
// per-keystroke seperti dulu. `values` di sini cuma isian item-item dalam
// kategori ini (bukan seluruh checklist), supaya kalau device lain baru saja
// menyelesaikan kategori LAIN, isian device lain itu tidak ketiban/hilang —
// RPC di server men-jsonb_set/merge cuma key item milik kategori ini.
export async function completeCategory(supabase, checklist, categoryId, values) {
  // Optimistic cache lokal duluan biar UI kerasa instan (server jadi sumber kebenaran).
  const optimisticCache = {
    ...checklist,
    values: { ...checklist.values, ...values },
    categoryDone: { ...checklist.categoryDone, [categoryId]: true },
    submittedAt: null,
  };
  saveChecklistCache(optimisticCache);

  const { data, error } = await supabase.rpc('complete_stock_checklist_category', {
    p_key: checklist.key,
    p_date_str: checklist.dateStr,
    p_category_id: categoryId,
    p_values: values, // object { [itemId]: { qty, skipped } } — hanya item kategori ini
  });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  // Kalau row null (misal checklist sudah locked duluan di server, jadi RPC
  // sengaja tidak update apa-apa), pakai checklist yang ada saja.
  const merged = row ? rowToChecklist(row) : checklist;
  saveChecklistCache(merged);
  return merged;
}

// Buka lagi kategori yang sudah ditandai selesai (sebelum checklist keseluruhan
// di-share ke WA), supaya bisa diedit ulang. Cuma mengubah categoryDone,
// TIDAK menghapus isian `values` yang sudah ada (biar gak perlu isi ulang dari 0).
export async function reopenCategory(supabase, checklist, categoryId) {
  const optimisticCache = {
    ...checklist,
    categoryDone: { ...checklist.categoryDone, [categoryId]: false },
  };
  saveChecklistCache(optimisticCache);

  const { data, error } = await supabase.rpc('reopen_stock_checklist_category', {
    p_key: checklist.key,
    p_category_id: categoryId,
  });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  const merged = row ? rowToChecklist(row) : checklist;
  saveChecklistCache(merged);
  return merged;
}

// Sebuah kategori dianggap "punya gate wajib" kalau minimal 1 item di
// dalamnya required=true. Kategori isi-opsional-semua tidak menge-gate apa pun.
function categoryHasRequiredItems(category) {
  return category.items.some((it) => it.required);
}

// Kategori dianggap lengkap (siap ditandai "Selesai") kalau SEMUA item wajib
// di dalamnya sudah terisi qty yang valid. Item opsional bebas kosong.
export function isCategoryFilledComplete(category, checklist) {
  return category.items.every((it) => {
    if (!it.required) return true;
    const v = checklist.values[it.id];
    if (!v) return false;
    return v.qty !== null && v.qty !== '' && !Number.isNaN(Number(v.qty));
  });
}

// Progress ringkas kategori: berapa item wajib yang sudah terisi dari total
// item wajib di kategori itu — dipakai untuk badge "3/5" di UI.
export function categoryRequiredProgress(category, checklist) {
  const required = category.items.filter((it) => it.required);
  const filled = required.filter((it) => {
    const v = checklist.values[it.id];
    return v && v.qty !== null && v.qty !== '' && !Number.isNaN(Number(v.qty));
  });
  return { filled: filled.length, total: required.length };
}

// Checklist keseluruhan dianggap complete kalau SEMUA kategori yang punya
// item wajib sudah ditandai done=true. Kategori tanpa item wajib sama sekali
// tidak nge-gate (boleh gak disentuh/gak ditandai selesai).
export function isChecklistComplete(checklist, master) {
  const items = allItemsFlat(master);
  if (items.length === 0) return true; // belum ada master item = tidak nge-gate apa-apa
  const gatingCategories = master.categories.filter(categoryHasRequiredItems);
  if (gatingCategories.length === 0) return true; // tidak ada kategori dengan item wajib
  return gatingCategories.every((c) => !!checklist.categoryDone?.[c.id]);
}

// Checklist dianggap terkunci (gak bisa diedit lagi di device manapun) begitu
// ada device yang berhasil membagikannya ke WhatsApp — lihat markShared.
export function isChecklistLocked(checklist) {
  return !!checklist.locked;
}

// Pakai RPC submit_stock_checklist supaya cuma kolom submitted_at/submitted_by
// yang berubah — TIDAK menimpa `values` kalau device lain baru saja menambah
// isian yang belum sempat di-refresh state lokal device ini (race condition
// yang sebelumnya bisa bikin isian device lain hilang saat device ini submit).
export async function submitChecklist(supabase, checklist, submittedBy) {
  const { data, error } = await supabase.rpc('submit_stock_checklist', {
    p_key: checklist.key,
    p_submitted_by: submittedBy || null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  const merged = row ? rowToChecklist(row) : checklist;
  saveChecklistCache(merged);
  return merged;
}

// Dipanggil saat satu karyawan menekan "Bagikan ke WhatsApp". Ini yang bikin
// checklist locked=true untuk SEMUA device — device lain yang masih buka form
// yang sama akan otomatis ke-update lewat subscribeStockChecklist dan melihat
// gate absen pulang ikut kebuka. Pakai RPC share_stock_checklist supaya
// `values` tidak ikut ditimpa (sama alasan seperti submitChecklist di atas).
export async function markShared(supabase, checklist) {
  const { data, error } = await supabase.rpc('share_stock_checklist', {
    p_key: checklist.key,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  const merged = row ? rowToChecklist(row) : checklist;
  saveChecklistCache(merged);
  return merged;
}

// Ambil semua histori checklist yang pernah dibuat dari Supabase, urut dari
// terbaru, untuk keperluan menampilkan log/riwayat kalau suatu saat dibutuhkan.
export async function listChecklistHistory(supabase) {
  const { data, error } = await supabase
    .from(CHECKLIST_TABLE)
    .select('*')
    .order('date_str', { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToChecklist);
}

// Format teks untuk dibagikan ke WhatsApp — grup per kategori, nama - jumlah - satuan.
// Item yang belum diisi (qty kosong/null, dan bukan skipped-dengan-nilai) TIDAK
// ikut dikirim, supaya pesan WA cuma berisi item yang benar-benar ada isinya
// dan gampang dibaca.
export function formatWhatsAppText(checklist, master) {
  const dateStr = checklist.dateStr;
  const [y, m, d] = dateStr.split('-');
  const lines = [`*Stock List — ${d}/${m}/${y}*`, '_Untuk belanja besok_', ''];

  for (const cat of master.categories) {
    if (cat.items.length === 0) continue;
    const filledItems = cat.items.filter((it) => {
      const v = checklist.values[it.id];
      return v && v.qty !== null && v.qty !== '' && !v.skipped;
    });
    if (filledItems.length === 0) continue; // kategori tanpa item terisi dilewati semua

    lines.push(`*${cat.name}*`);
    for (const it of filledItems) {
      const v = checklist.values[it.id];
      lines.push(`- ${it.name}: ${v.qty} ${it.unit || ''}`.trim());
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

export function buildWhatsAppShareUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
