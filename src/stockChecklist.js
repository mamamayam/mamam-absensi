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
//  - "stockChecklist_<key>"  → { key, dateStr, values: { [itemId]: { qty, skipped } }, submittedAt, sharedAt }
//    Checklist harian TETAP di localStorage saja (device-specific, tidak perlu
//    disinkron — ini catatan pengisian stock oleh kasir yang lagi bertugas
//    hari itu di device itu).
//
// "key" biasanya sama dengan dateStr (YYYY-MM-DD) hari checklist itu dibuat,
// tapi kalau checklist belum dibagikan ke WhatsApp, dia TIDAK dihapus/direset
// walau sudah ganti hari — checklist lama itu yang tetap jadi checklist aktif
// sampai ada yang menekan "Bagikan ke WhatsApp".

import { getTodayStr } from './utils.js';

const MASTER_KEY = 'stockMaster_v1';
const CHECKLIST_PREFIX = 'stockChecklist_';
const STOCK_MASTER_CONFIG_KEY = 'stockMaster';

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

// ── Checklist harian ──────────────────────────────────────────────────────────
function checklistStorageKey(key) {
  return CHECKLIST_PREFIX + key;
}

function emptyChecklist(key, dateStr) {
  return { key, dateStr, values: {}, submittedAt: null, sharedAt: null };
}

function loadChecklistByKey(key) {
  try {
    const raw = localStorage.getItem(checklistStorageKey(key));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function saveChecklist(checklist) {
  localStorage.setItem(checklistStorageKey(checklist.key), JSON.stringify(checklist));
}

// Cari semua checklist tersimpan yang submitted tapi BELUM dibagikan — itu
// artinya masih "nyangkut" dari hari sebelumnya dan harus tetap jadi checklist
// aktif sampai dibagikan, biar gak keburu ke-reset otomatis pas ganti hari.
function findPendingUnsharedChecklist() {
  let found = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(CHECKLIST_PREFIX)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(k));
      if (parsed?.submittedAt && !parsed?.sharedAt) {
        if (!found || new Date(parsed.submittedAt) < new Date(found.submittedAt)) {
          found = parsed; // ambil yang paling lama nyangkut
        }
      }
    } catch (_) {
      // abaikan entry rusak
    }
  }
  return found;
}

// Checklist aktif untuk saat ini:
// 1. Kalau ada checklist lama yang submitted tapi belum dibagikan → itu yang aktif
//    (harus dibagikan dulu sebelum bisa mulai checklist baru), walau sudah ganti hari.
// 2. Kalau tidak ada → pakai/buat checklist "hari ini" yang masih terbuka (belum shared).
//    Kalau checklist "hari ini" sudah pernah dibagikan (siklus closed), buat checklist
//    baru dengan key unik supaya tidak menimpa arsip yang sudah dibagikan.
export function getActiveChecklist() {
  const pending = findPendingUnsharedChecklist();
  if (pending) return pending;

  const todayStr = getTodayStr();
  const existing = loadChecklistByKey(todayStr);
  if (existing && !existing.sharedAt) return existing;

  return emptyChecklist(existing ? `${todayStr}-${generateStockId().slice(0, 8)}` : todayStr, todayStr);
}

export function setItemValue(checklist, itemId, { qty, skipped }) {
  const next = {
    ...checklist,
    values: { ...checklist.values, [itemId]: { qty: qty ?? null, skipped: !!skipped } },
    // begitu diedit lagi, submittedAt dicabut supaya gate nyala lagi kalau ada perubahan
    submittedAt: null,
  };
  saveChecklist(next);
  return next;
}

export function isChecklistComplete(checklist, master) {
  const items = allItemsFlat(master);
  if (items.length === 0) return true; // belum ada master item = tidak nge-gate apa-apa
  // Cuma item WAJIB yang nge-gate submit. Item opsional bebas — mau diisi,
  // di-"Isi Nanti", atau gak disentuh sama sekali, gak mempengaruhi status
  // complete.
  return items.every((it) => {
    if (!it.required) return true;
    const v = checklist.values[it.id];
    if (!v) return false;
    return v.qty !== null && v.qty !== '' && !Number.isNaN(Number(v.qty));
  });
}

export function submitChecklist(checklist) {
  const next = { ...checklist, submittedAt: new Date().toISOString() };
  saveChecklist(next);
  return next;
}

export function markShared(checklist) {
  const next = { ...checklist, sharedAt: new Date().toISOString() };
  saveChecklist(next);
  return next;
}

// NOTE: dulu fungsi ini menghapus checklist lama yang sudah dibagikan + beda
// tanggal dari localStorage. Sekarang TIDAK — histori checklist per tanggal
// dibiarkan tetap ada selamanya sebagai arsip. Yang "kosong" saat ganti hari
// hanyalah checklist AKTIF baru (lihat getActiveChecklist), bukan menghapus
// data checklist tanggal-tanggal sebelumnya.
// Fungsi ini tetap ada (no-op) supaya pemanggilnya tidak perlu diubah.
export function cleanupOldSharedChecklists() {
  // sengaja tidak melakukan apa-apa — histori checklist tidak dihapus.
}

// Ambil semua histori checklist yang pernah dibuat, urut dari terbaru,
// untuk keperluan menampilkan log/riwayat kalau suatu saat dibutuhkan.
export function listChecklistHistory() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(CHECKLIST_PREFIX)) continue;
    try {
      out.push(JSON.parse(localStorage.getItem(k)));
    } catch (_) {
      // abaikan entry rusak
    }
  }
  return out.sort((a, b) => new Date(b.dateStr) - new Date(a.dateStr));
}

// Format teks untuk dibagikan ke WhatsApp — grup per kategori, nama - jumlah - satuan.
export function formatWhatsAppText(checklist, master) {
  const dateStr = checklist.dateStr;
  const [y, m, d] = dateStr.split('-');
  const lines = [`*Stock List — ${d}/${m}/${y}*`, '_Untuk belanja besok_', ''];

  for (const cat of master.categories) {
    if (cat.items.length === 0) continue;
    lines.push(`*${cat.name}*`);
    for (const it of cat.items) {
      const v = checklist.values[it.id];
      if (v?.skipped) {
        lines.push(`- ${it.name}: (belum diisi)`);
      } else {
        const qty = v?.qty ?? '-';
        lines.push(`- ${it.name}: ${qty} ${it.unit || ''}`.trim());
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

export function buildWhatsAppShareUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}