import { useState, useEffect } from 'react';
import {
  ClipboardList, ChevronDown, ChevronUp, Plus, Trash2, Pencil,
  CheckCircle2, Circle, Share2, X, AlertTriangle, ListPlus, Check,
  GripVertical, ArrowUp, ArrowDown, Loader2, WifiOff,
} from 'lucide-react';
import { supabase } from './supabase.js';
import {
  loadMasterCached, loadMasterFromServer, saveMasterToServer, subscribeStockMaster,
  addCategory, renameCategory, deleteCategory,
  addItem, updateItem, deleteItem, allItemsFlat, seedDefaultStock,
  getActiveChecklist, setItemValue, isChecklistComplete,
  submitChecklist, markShared, cleanupOldSharedChecklists,
  formatWhatsAppText, buildWhatsAppShareUrl,
  reorderCategory, reorderItem, moveItemToCategory,
} from './stockChecklist.js';

// Hanya nama ini yang boleh mengelola kategori/item (tambah, edit, hapus,
// ubah wajib/opsional). Karyawan lain hanya bisa isi checklist & bagikan.
const STOCK_ADMIN_NAME = 'Agung Prayoga';

function isStockAdmin(name) {
  return (name || '').trim().toLowerCase() === STOCK_ADMIN_NAME.toLowerCase();
}

// ── Kartu ringkas + expand: dipakai di layar utama sebelum absen ────────────
export default function StockChecklistCard({ onGateStatusChange, currentEmployeeName }) {
  // Master kategori/item: mulai dari cache lokal (instan, biar gak nge-blank),
  // lalu di-refresh dari Supabase begitu datang. Sinkron ke device lain lewat
  // realtime subscription di bawah.
  const [master, setMaster] = useState(() => loadMasterCached());
  const [masterLoading, setMasterLoading] = useState(true);
  const [masterSyncError, setMasterSyncError] = useState('');
  const [checklist, setChecklist] = useState(() => getActiveChecklist());
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [justShared, setJustShared] = useState(false);

  const canManage = isStockAdmin(currentEmployeeName);

  useEffect(() => {
    cleanupOldSharedChecklists();
  }, []);

  // Ambil master terbaru dari Supabase saat komponen mount, lalu subscribe
  // supaya perubahan dari device lain (misal admin edit di laptop) otomatis
  // masuk ke sini tanpa perlu reload.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const serverMaster = await loadMasterFromServer(supabase);
        if (cancelled) return;
        setMasterSyncError('');
        setMaster(serverMaster);
      } catch (err) {
        if (cancelled) return;
        // Gagal konek — tetap pakai cache lokal yang sudah ke-load duluan,
        // cuma kasih tau user datanya mungkin belum yang terbaru.
        setMasterSyncError('Gagal sinkron data terbaru, menampilkan data tersimpan di device ini.');
      } finally {
        if (!cancelled) setMasterLoading(false);
      }
    })();

    const unsubscribe = subscribeStockMaster(supabase, (remoteMaster) => {
      setMaster(remoteMaster);
      setMasterSyncError('');
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Karyawan biasa gak boleh buka panel kelola — kalau somehow kebuka lalu
  // gantian pilih nama yang bukan admin, tutup paksa panelnya.
  useEffect(() => {
    if (!canManage) setManageOpen(false);
  }, [canManage]);

  const items = allItemsFlat(master);
  const complete = isChecklistComplete(checklist, master);
  const alreadySubmitted = !!checklist.submittedAt;
  const alreadyShared = !!checklist.sharedAt;
  const gateOpen = items.length === 0 || alreadySubmitted;

  useEffect(() => {
    onGateStatusChange?.({ gateOpen, hasItems: items.length > 0, complete });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateOpen, items.length, complete]);

  useEffect(() => {
    if (!selectedCategoryId && master.categories.length > 0) {
      setSelectedCategoryId(master.categories[0].id);
    }
  }, [master.categories, selectedCategoryId]);

  // Optimistic update: UI langsung berubah pakai `next`, baru kemudian
  // disimpan ke Supabase di background. Kalau gagal simpan, kasih tau user
  // lewat masterSyncError (datanya tetap ada di layar, cuma belum ke-sync).
  const refreshMaster = async (next) => {
    setMaster(next);
    try {
      await saveMasterToServer(supabase, next);
      setMasterSyncError('');
    } catch (err) {
      setMasterSyncError('Gagal menyimpan perubahan ke server. Cek koneksi lalu coba lagi.');
    }
  };
  const refreshChecklist = (next) => setChecklist(next);

  const handleSetValue = (itemId, patch) => {
    refreshChecklist(setItemValue(checklist, itemId, patch));
  };

  const handleSubmit = () => {
    if (!complete) return;
    refreshChecklist(submitChecklist(checklist));
  };

  const handleShare = () => {
    const text = formatWhatsAppText(checklist, master);
    window.open(buildWhatsAppShareUrl(text), '_blank');
    refreshChecklist(markShared(checklist));
    setJustShared(true);
  };

  const selectedCategory = master.categories.find((c) => c.id === selectedCategoryId);

  return (
    <div className="bg-white rounded-3xl shadow-lg overflow-hidden mt-3 mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center ${
              gateOpen ? 'bg-green-100' : 'bg-amber-100'
            }`}
          >
            <ClipboardList className={`w-5 h-5 ${gateOpen ? 'text-green-600' : 'text-amber-600'}`} />
          </div>
          <div>
            <p className="text-sm font-bold text-stone-800">Stock List Belanja</p>
            <p className="text-xs text-stone-400">
              {masterLoading
                ? 'Memuat data stock...'
                : items.length === 0
                ? 'Belum ada item — tap untuk tambah'
                : alreadyShared
                ? 'Sudah dibagikan ke grup'
                : alreadySubmitted
                ? 'Sudah diisi, absen pulang terbuka'
                : `Wajib diisi sebelum absen pulang · ${items.length} item`}
            </p>
          </div>
        </div>
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
            open ? 'bg-orange-100' : 'bg-stone-100'
          }`}
        >
          {masterLoading ? (
            <Loader2 className="w-4 h-4 text-stone-400 animate-spin" />
          ) : open ? (
            <ChevronUp className="w-4 h-4 text-orange-600" />
          ) : (
            <ChevronDown className="w-4 h-4 text-stone-500" />
          )}
        </div>
      </button>

      {!gateOpen && !open && (
        <div className="mx-5 mb-4 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <p className="text-xs text-amber-700 font-medium leading-relaxed">
            Isi stock list dulu, baru absen pulang bisa dibuka.
          </p>
        </div>
      )}

      {open && (
        <div className="border-t border-stone-100 px-5 pt-4 pb-5 space-y-4">
          {masterSyncError && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3.5 py-2.5">
              <WifiOff className="w-4 h-4 text-red-500 shrink-0" />
              <p className="text-xs text-red-600 font-medium leading-relaxed">{masterSyncError}</p>
            </div>
          )}

          {items.length === 0 && !manageOpen && (
            <div className="text-center py-4">
              <p className="text-xs text-stone-400 mb-3">Belum ada kategori/item stock. Tambahkan dulu.</p>
              {canManage ? (
                <div className="flex flex-col items-center gap-2">
                  <button
                    onClick={() => setManageOpen(true)}
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-orange-600 bg-orange-50 px-3 py-2 rounded-lg"
                  >
                    <ListPlus className="w-3.5 h-3.5" /> Kelola Kategori & Item
                  </button>
                  <button
                    onClick={() => refreshMaster(seedDefaultStock())}
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-stone-500 bg-stone-100 px-3 py-2 rounded-lg"
                  >
                    Muat Data Stock Awal (dari daftar outlet)
                  </button>
                </div>
              ) : (
                <p className="text-xs text-stone-400 italic">Hubungi {STOCK_ADMIN_NAME} untuk menambahkan.</p>
              )}
            </div>
          )}

          {items.length > 0 && !alreadyShared && (
            <>
              {/* Dropdown kategori */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-stone-500 block">Kategori</label>
                <select
                  value={selectedCategoryId}
                  onChange={(e) => setSelectedCategoryId(e.target.value)}
                  className="w-full border border-stone-200 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
                >
                  {master.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.items.length})
                    </option>
                  ))}
                </select>
              </div>

              {/* Sub-kategori / item dalam kategori terpilih */}
              {selectedCategory && (
                <div className="space-y-2.5">
                  {selectedCategory.items.length === 0 && (
                    <p className="text-xs text-stone-400 italic">Belum ada item di kategori ini.</p>
                  )}
                  {selectedCategory.items.map((it) => {
                    const v = checklist.values[it.id];
                    const filled = v && (v.skipped || (v.qty !== null && v.qty !== ''));
                    return (
                      <div
                        key={it.id}
                        className={`rounded-2xl border px-3.5 py-3 ${
                          filled ? 'border-green-200 bg-green-50/40' : 'border-stone-200'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {filled ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
                            ) : (
                              <Circle className="w-3.5 h-3.5 text-stone-300 shrink-0" />
                            )}
                            <span className="text-sm font-medium text-stone-700 truncate">{it.name}</span>
                          </div>
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ml-2 ${
                              it.required ? 'bg-red-50 text-red-500' : 'bg-stone-100 text-stone-400'
                            }`}
                          >
                            {it.required ? 'WAJIB' : 'OPSIONAL'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            placeholder="Jumlah stock"
                            value={v?.qty ?? ''}
                            disabled={v?.skipped}
                            onChange={(e) =>
                              handleSetValue(it.id, { qty: e.target.value, skipped: false })
                            }
                            className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-stone-100 disabled:text-stone-400"
                          />
                          <span className="text-xs text-stone-400 w-14 shrink-0">{it.unit || '-'}</span>
                        </div>
                        {!it.required && (
                          <button
                            onClick={() =>
                              handleSetValue(it.id, {
                                qty: v?.skipped ? '' : null,
                                skipped: !v?.skipped,
                              })
                            }
                            className={`mt-2 text-[11px] font-bold px-2.5 py-1 rounded-lg ${
                              v?.skipped ? 'bg-stone-700 text-white' : 'bg-stone-100 text-stone-500'
                            }`}
                          >
                            {v?.skipped ? '✓ Dilewati — tap batal' : 'Isi Nanti'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {!complete && (
                <p className="text-[11px] text-amber-600 text-center">
                  Lengkapi semua item wajib untuk lanjut. Item opsional boleh dilewati.
                </p>
              )}

              {!alreadySubmitted ? (
                <button
                  onClick={handleSubmit}
                  disabled={!complete}
                  className="w-full bg-orange-600 disabled:bg-stone-200 disabled:text-stone-400 text-white font-bold py-3 rounded-xl transition"
                >
                  Selesai Isi Checklist
                </button>
              ) : (
                <button
                  onClick={handleShare}
                  className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition"
                >
                  <Share2 className="w-4 h-4" /> Bagikan ke WhatsApp
                </button>
              )}
            </>
          )}

          {alreadyShared && (
            <div className="text-center py-2">
              <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2" />
              <p className="text-sm font-medium text-stone-700">Checklist sudah dibagikan</p>
              <p className="text-xs text-stone-400 mt-0.5">
                {justShared ? 'Berhasil dibuka di WhatsApp.' : `Terkirim ${new Date(checklist.sharedAt).toLocaleString('id-ID')}`}
              </p>
            </div>
          )}

          {canManage && (
            <div className="pt-1 border-t border-stone-100">
              <button
                onClick={() => setManageOpen((v) => !v)}
                className="w-full flex items-center justify-center gap-1.5 text-xs font-bold text-stone-500 py-2"
              >
                <ListPlus className="w-3.5 h-3.5" />
                {manageOpen ? 'Tutup Pengaturan' : 'Kelola Kategori & Item'}
              </button>
            </div>
          )}

          {canManage && manageOpen && (
            <ManageStockMaster master={master} onChange={refreshMaster} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Panel kelola kategori & item ─────────────────────────────────────────────
function ManageStockMaster({ master, onChange }) {
  const [newCatName, setNewCatName] = useState('');
  const [editingCatId, setEditingCatId] = useState(null);
  const [editingCatName, setEditingCatName] = useState('');
  const [itemForms, setItemForms] = useState({}); // { [categoryId]: { name, unit, required } }
  const [editingItem, setEditingItem] = useState(null); // { categoryId, itemId, name, unit }

  // Item tetap pakai drag reorder
  const [dragItem, setDragItem] = useState(null); // { categoryId, index }
  const [overItem, setOverItem] = useState(null); // { categoryId, index }

  const handleAddCategory = () => {
    const name = newCatName.trim();
    if (!name) return;
    onChange(addCategory(master, name));
    setNewCatName('');
  };

  const startEditCat = (cat) => {
    setEditingCatId(cat.id);
    setEditingCatName(cat.name);
  };

  const saveEditCat = (catId) => {
    const name = editingCatName.trim();
    if (name) onChange(renameCategory(master, catId, name));
    setEditingCatId(null);
    setEditingCatName('');
  };

  const handleDeleteCategory = (catId) => {
    onChange(deleteCategory(master, catId));
  };

  const getItemForm = (catId) => itemForms[catId] || { name: '', unit: '', required: true };
  const setItemForm = (catId, patch) =>
    setItemForms((prev) => ({ ...prev, [catId]: { ...getItemForm(catId), ...patch } }));

  const handleAddItem = (catId) => {
    const form = getItemForm(catId);
    const name = form.name.trim();
    if (!name) return;
    onChange(addItem(master, catId, { name, unit: form.unit.trim(), required: form.required }));
    setItemForm(catId, { name: '', unit: '', required: form.required });
  };

  // ── Edit item (nama & satuan) ───────────────────────────────────────────
  const startEditItem = (catId, it) => {
    setEditingItem({ categoryId: catId, itemId: it.id, name: it.name, unit: it.unit || '' });
  };

  const saveEditItem = () => {
    if (!editingItem) return;
    const name = editingItem.name.trim();
    if (!name) return;
    onChange(
      updateItem(master, editingItem.categoryId, editingItem.itemId, {
        name,
        unit: editingItem.unit.trim(),
      })
    );
    setEditingItem(null);
  };

  const cancelEditItem = () => setEditingItem(null);

  // ── Reorder kategori pakai panah naik/turun ─────────────────────────────
  const moveCategoryUp = (index) => {
    if (index <= 0) return;
    onChange(reorderCategory(master, index, index - 1));
  };

  const moveCategoryDown = (index) => {
    if (index >= master.categories.length - 1) return;
    onChange(reorderCategory(master, index, index + 1));
  };

  // ── Drag reorder item (dalam satu kategori) ─────────────────────────────
  const handleItemDragStart = (categoryId, index) => (e) => {
    e.stopPropagation();
    setDragItem({ categoryId, index });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleItemDragOver = (categoryId, index) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragItem || dragItem.categoryId !== categoryId) return;
    if (!overItem || overItem.categoryId !== categoryId || overItem.index !== index) {
      setOverItem({ categoryId, index });
    }
  };

  const handleItemDrop = (categoryId, index) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragItem && dragItem.categoryId === categoryId && dragItem.index !== index) {
      onChange(reorderItem(master, categoryId, dragItem.index, index));
    }
    setDragItem(null);
    setOverItem(null);
  };

  const handleItemDragEnd = () => {
    setDragItem(null);
    setOverItem(null);
  };

  return (
    <div className="bg-stone-50 rounded-2xl p-3.5 space-y-3">
      <p className="text-xs font-bold text-stone-500">Tambah Kategori Baru</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={newCatName}
          onChange={(e) => setNewCatName(e.target.value)}
          placeholder="Nama kategori, misal: Sayuran"
          className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
        <button
          onClick={handleAddCategory}
          className="bg-orange-600 text-white px-3 rounded-lg flex items-center justify-center shrink-0"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <p className="text-[10px] text-stone-400 italic px-0.5">
        Pakai panah <ArrowUp className="w-3 h-3 inline -mt-0.5" />/<ArrowDown className="w-3 h-3 inline -mt-0.5" /> untuk urutkan kategori, atau tahan ikon <GripVertical className="w-3 h-3 inline -mt-0.5" /> untuk urutkan item.
      </p>

      <div className="space-y-3 pt-1">
        {master.categories.map((cat, catIndex) => (
          <div
            key={cat.id}
            className="bg-white rounded-xl p-3 border border-stone-200"
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              {editingCatId === cat.id ? (
                <div className="flex items-center gap-1.5 flex-1">
                  <input
                    type="text"
                    value={editingCatName}
                    onChange={(e) => setEditingCatName(e.target.value)}
                    className="flex-1 border border-stone-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                    autoFocus
                  />
                  <button onClick={() => saveEditCat(cat.id)} className="text-green-600 shrink-0">
                    <Check className="w-4 h-4" />
                  </button>
                  <button onClick={() => setEditingCatId(null)} className="text-stone-400 shrink-0">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <div className="flex flex-col shrink-0 -my-1">
                      <button
                        onClick={() => moveCategoryUp(catIndex)}
                        disabled={catIndex === 0}
                        className={`p-0.5 rounded ${
                          catIndex === 0 ? 'text-stone-200' : 'text-stone-400 hover:text-orange-600'
                        }`}
                        title="Pindah kategori ke atas"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => moveCategoryDown(catIndex)}
                        disabled={catIndex === master.categories.length - 1}
                        className={`p-0.5 rounded ${
                          catIndex === master.categories.length - 1
                            ? 'text-stone-200'
                            : 'text-stone-400 hover:text-orange-600'
                        }`}
                        title="Pindah kategori ke bawah"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <span className="text-sm font-bold text-stone-700 truncate">{cat.name}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => startEditCat(cat)} className="text-stone-400">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDeleteCategory(cat.id)} className="text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* List item existing */}
            <div className="space-y-1.5 mb-2">
              {cat.items.map((it, itIndex) => {
                const isEditingThis =
                  editingItem?.categoryId === cat.id && editingItem?.itemId === it.id;
                const isDragOverThis =
                  overItem?.categoryId === cat.id &&
                  overItem?.index === itIndex &&
                  dragItem?.categoryId === cat.id &&
                  dragItem?.index !== itIndex;

                if (isEditingThis) {
                  return (
                    <div
                      key={it.id}
                      className="flex items-center gap-1.5 bg-orange-50/60 border border-orange-200 rounded-lg px-2.5 py-1.5"
                    >
                      <input
                        type="text"
                        value={editingItem.name}
                        onChange={(e) =>
                          setEditingItem((prev) => ({ ...prev, name: e.target.value }))
                        }
                        placeholder="Nama barang"
                        className="flex-1 min-w-0 border border-stone-200 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEditItem();
                          if (e.key === 'Escape') cancelEditItem();
                        }}
                      />
                      <input
                        type="text"
                        value={editingItem.unit}
                        onChange={(e) =>
                          setEditingItem((prev) => ({ ...prev, unit: e.target.value }))
                        }
                        placeholder="Satuan"
                        className="w-14 shrink-0 border border-stone-200 rounded-md px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEditItem();
                          if (e.key === 'Escape') cancelEditItem();
                        }}
                      />
                      <button onClick={saveEditItem} className="text-green-600 shrink-0">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={cancelEditItem} className="text-stone-400 shrink-0">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                }

                return (
                  <div
                    key={it.id}
                    onDragOver={handleItemDragOver(cat.id, itIndex)}
                    onDrop={handleItemDrop(cat.id, itIndex)}
                    className={`rounded-lg border transition-colors ${
                      isDragOverThis
                        ? 'border-orange-400 bg-orange-50/50'
                        : 'border-transparent bg-stone-50'
                    } ${dragItem?.categoryId === cat.id && dragItem?.index === itIndex ? 'opacity-40' : ''}`}
                  >
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                      <span
                        draggable
                        onDragStart={handleItemDragStart(cat.id, itIndex)}
                        onDragEnd={handleItemDragEnd}
                        className="text-stone-300 shrink-0 cursor-grab active:cursor-grabbing touch-none"
                        title="Geser untuk urutkan item"
                      >
                        <GripVertical className="w-3.5 h-3.5" />
                      </span>
                      <span className="text-xs flex-1 truncate">{it.name}</span>
                      <span className="text-[10px] text-stone-400 shrink-0">{it.unit}</span>
                      <button
                        onClick={() => startEditItem(cat.id, it)}
                        className="text-stone-400 shrink-0"
                        title="Edit item"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() =>
                          onChange(updateItem(master, cat.id, it.id, { required: !it.required }))
                        }
                        className={`text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                          it.required ? 'bg-red-50 text-red-500' : 'bg-stone-200 text-stone-500'
                        }`}
                      >
                        {it.required ? 'WAJIB' : 'OPSIONAL'}
                      </button>
                      <button
                        onClick={() => onChange(deleteItem(master, cat.id, it.id))}
                        className="text-red-400 shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>

                    {master.categories.length > 1 && (
                      <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pl-8">
                        <span className="text-[10px] text-stone-400 shrink-0">Pindah ke:</span>
                        <select
                          value=""
                          onChange={(e) => {
                            const targetId = e.target.value;
                            if (targetId) {
                              onChange(moveItemToCategory(master, cat.id, it.id, targetId));
                            }
                          }}
                          className="flex-1 min-w-0 text-[10px] border border-stone-200 rounded-md px-1.5 py-1 bg-white text-stone-500 focus:outline-none focus:ring-1 focus:ring-orange-400"
                        >
                          <option value="">Pilih kategori lain...</option>
                          {master.categories
                            .filter((c) => c.id !== cat.id)
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Form tambah item */}
            <div className="flex gap-1.5">
              <input
                type="text"
                placeholder="Nama barang"
                value={getItemForm(cat.id).name}
                onChange={(e) => setItemForm(cat.id, { name: e.target.value })}
                className="flex-1 min-w-0 border border-stone-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <input
                type="text"
                placeholder="Satuan"
                value={getItemForm(cat.id).unit}
                onChange={(e) => setItemForm(cat.id, { unit: e.target.value })}
                className="w-16 shrink-0 border border-stone-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <button
                onClick={() =>
                  setItemForm(cat.id, { required: !getItemForm(cat.id).required })
                }
                className={`shrink-0 text-[9px] font-bold px-2 rounded-lg ${
                  getItemForm(cat.id).required ? 'bg-red-50 text-red-500' : 'bg-stone-100 text-stone-400'
                }`}
              >
                {getItemForm(cat.id).required ? 'WAJIB' : 'OPS'}
              </button>
              <button
                onClick={() => handleAddItem(cat.id)}
                className="shrink-0 bg-stone-700 text-white px-2.5 rounded-lg flex items-center justify-center"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}