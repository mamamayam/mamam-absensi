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
//    { qty, skipped } }), submitted_at, submitted_by, shared_at, locked.
//    SINKRON real-time antar device (lihat subscribeStockChecklist) supaya
//    karyawan bisa bagi tugas isi form checklist di HP masing-masing —
//    begitu satu HP isi satu item, HP lain langsung lihat progressnya.
//    localStorage ("stockChecklist_<key>") dipakai HANYA sebagai cache lokal,
//    sama polanya seperti stockMaster.
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
// Balikin fungsi unsubscribe untuk dipanggil di cleanup useEffect.
export function subscribeStockMaster(supabase, onRemoteChange) {
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
    .subscribe();

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
    submittedAt: null,
    submittedBy: null,
    sharedAt: null,
    locked: false,
  };
}

// Konversi row Supabase (snake_case) <-> bentuk lokal (camelCase) yang dipakai UI.
function rowToChecklist(row) {
  return {
    key: row.key,
    dateStr: row.date_str,
    values: row.values || {},
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by ?? null,
    sharedAt: row.shared_at,
    locked: !!row.locked,
  };
}

function checklistToRow(checklist) {
  return {
    key: checklist.key,
    date_str: checklist.dateStr,
    values: checklist.values,
    submitted_at: checklist.submittedAt,
    submitted_by: checklist.submittedBy ?? null,
    shared_at: checklist.sharedAt,
    locked: !!checklist.locked,
    updated_at: new Date().toISOString(),
  };
}

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

// Cari cache lokal checklist yang submitted tapi belum locked/shared — dipakai
// sebagai fallback instan sebelum data server datang (lihat loadChecklistCached).
function findPendingUnsharedChecklistCache() {
  let found = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(CHECKLIST_PREFIX)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(k));
      if (parsed?.submittedAt && !parsed?.locked) {
        if (!found || new Date(parsed.submittedAt) < new Date(found.submittedAt)) {
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
// sama pola seperti loadMasterCached().
export function loadChecklistCached() {
  const pending = findPendingUnsharedChecklistCache();
  if (pending) return pending;
  const todayStr = getTodayStr();
  const existing = loadChecklistCacheByKey(todayStr);
  if (existing && !existing.locked) return existing;
  return emptyChecklist(todayStr, todayStr);
}

// Ambil checklist aktif dari Supabase:
// 1. Kalau ada row submitted tapi belum locked → itu yang aktif (harus dibagikan
//    dulu / ke-lock dulu sebelum bisa mulai checklist baru), walau sudah ganti hari.
// 2. Kalau tidak ada → pakai/buat row "hari ini" yang masih terbuka (belum locked).
//    Kalau row "hari ini" sudah locked (siklus closed), buat checklist baru dengan
//    key unik supaya tidak menimpa arsip yang sudah dibagikan.
export async function loadActiveChecklistFromServer(supabase) {
  const { data: pendingRows, error: pendingErr } = await supabase
    .from(CHECKLIST_TABLE)
    .select('*')
    .not('submitted_at', 'is', null)
    .eq('locked', false)
    .order('submitted_at', { ascending: true })
    .limit(1);

  if (pendingErr) throw pendingErr;

  if (pendingRows && pendingRows.length > 0) {
    const checklist = rowToChecklist(pendingRows[0]);
    saveChecklistCache(checklist);
    return checklist;
  }

  const todayStr = getTodayStr();
  const { data: todayRow, error: todayErr } = await supabase
    .from(CHECKLIST_TABLE)
    .select('*')
    .eq('key', todayStr)
    .maybeSingle();

  if (todayErr) throw todayErr;

  if (todayRow && !todayRow.locked) {
    const checklist = rowToChecklist(todayRow);
    saveChecklistCache(checklist);
    return checklist;
  }

  // Belum ada row hari ini, atau row hari ini sudah locked → checklist baru.
  const key = todayRow ? `${todayStr}-${generateStockId().slice(0, 8)}` : todayStr;
  const fresh = emptyChecklist(key, todayStr);
  saveChecklistCache(fresh);
  return fresh;
}

// Subscribe ke perubahan tabel stock_checklists lewat Supabase Realtime, supaya
// begitu satu HP isi satu item, HP lain yang buka checklist yang sama (key sama)
// langsung lihat progressnya tanpa reload. Balikin fungsi unsubscribe.
export function subscribeStockChecklist(supabase, activeKey, onRemoteChange) {
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
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// Simpan checklist ke Supabase (upsert by key) + update cache lokal, lalu balikin
// hasilnya. Optimistic di sisi caller: UI sudah dipakai duluan lewat state lokal.
async function saveChecklistToServer(supabase, checklist) {
  saveChecklistCache(checklist);
  const { error } = await supabase
    .from(CHECKLIST_TABLE)
    .upsert(checklistToRow(checklist), { onConflict: 'key' });
  if (error) throw error;
  return checklist;
}

export async function setItemValue(supabase, checklist, itemId, { qty, skipped }) {
  const next = {
    ...checklist,
    values: { ...checklist.values, [itemId]: { qty: qty ?? null, skipped: !!skipped } },
    // begitu diedit lagi, submittedAt dicabut supaya gate nyala lagi kalau ada perubahan
    // (kalau sudah locked, ini tidak akan terpanggil — lihat gate di StockChecklist.jsx)
    submittedAt: null,
  };
  return saveChecklistToServer(supabase, next);
}

export function isChecklistComplete(checklist, master) {
  const items = allItemsFlat(master);
  if (items.length === 0) return true; // belum ada master item = tidak nge-gate apa-apa
  // Cuma item WAJIB yang nge-gate submit. Item opsional bebas — mau diisi atau
  // gak disentuh sama sekali, gak mempengaruhi status complete.
  return items.every((it) => {
    if (!it.required) return true;
    const v = checklist.values[it.id];
    if (!v) return false;
    return v.qty !== null && v.qty !== '' && !Number.isNaN(Number(v.qty));
  });
}

// Checklist dianggap terkunci (gak bisa diedit lagi di device manapun) begitu
// ada device yang berhasil membagikannya ke WhatsApp — lihat markShared.
export function isChecklistLocked(checklist) {
  return !!checklist.locked;
}

export async function submitChecklist(supabase, checklist, submittedBy) {
  const next = {
    ...checklist,
    submittedAt: new Date().toISOString(),
    submittedBy: submittedBy || null,
  };
  return saveChecklistToServer(supabase, next);
}

// Dipanggil saat satu karyawan menekan "Bagikan ke WhatsApp". Ini yang bikin
// checklist locked=true untuk SEMUA device — device lain yang masih buka form
// yang sama akan otomatis ke-update lewat subscribeStockChecklist dan melihat
// gate absen pulang ikut kebuka.
export async function markShared(supabase, checklist) {
  const next = { ...checklist, sharedAt: new Date().toISOString(), locked: true };
  return saveChecklistToServer(supabase, next);
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