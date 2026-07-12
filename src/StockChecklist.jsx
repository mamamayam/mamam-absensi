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
  loadChecklistCached, loadActiveChecklistFromServer, subscribeStockChecklist,
  completeCategory, reopenCategory, isCategoryFilledComplete, categoryRequiredProgress,
  isChecklistComplete, isChecklistLocked, pickNewerChecklist,
  submitChecklist, markShared,
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
  const [checklist, setChecklist] = useState(() => loadChecklistCached());
  const [checklistLoading, setChecklistLoading] = useState(true);
  const [checklistSyncError, setChecklistSyncError] = useState('');
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [justShared, setJustShared] = useState(false);
  // Draft lokal isian kategori yang SEDANG dibuka untuk diedit (belum di-push
  // ke server). Key = itemId, value = { qty, skipped }. Direset/diisi ulang
  // dari checklist.values setiap kali pindah kategori. Push ke server hanya
  // terjadi sekali, saat tombol "Selesai" kategori ditekan — BUKAN per-keystroke,
  // supaya ngetik angka panjang (ratusan/ribuan) tidak nge-lag karena tiap
  // karakter push ke Supabase.
  const [draftValues, setDraftValues] = useState({});
  const [savingCategory, setSavingCategory] = useState(false);
  // Loading khusus saat handleShareAgain terpaksa fetch ulang dari server
  // (state lokal kedeteksi kosong/basi) — biar tombol tidak dobel-klik
  // dan user tau lagi ngambil data, bukan cuma diam.
  const [shareAgainLoading, setShareAgainLoading] = useState(false);

  const canManage = isStockAdmin(currentEmployeeName);
  // Agung Prayoga juga boleh langsung "Selesai Isi Checklist" & bagikan ke WA
  // walau item wajib belum lengkap semua (bypass khusus dia saja).
  const canBypassChecklist = isStockAdmin(currentEmployeeName);

  // Ambil master terbaru dari Supabase saat komponen mount, lalu subscribe
  // supaya perubahan dari device lain (misal admin edit di laptop) otomatis
  // masuk ke sini tanpa perlu reload. onResync di subscribeStockMaster bikin
  // effect ini juga re-fetch tiap kali channel realtime (re)connect, jaga-jaga
  // ada perubahan yang kelewat selama koneksi sempat putus.
  useEffect(() => {
    let cancelled = false;

    const refetchMaster = async () => {
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
      }
    };

    (async () => {
      await refetchMaster();
      if (!cancelled) setMasterLoading(false);
    })();

    const unsubscribe = subscribeStockMaster(
      supabase,
      (remoteMaster) => {
        if (cancelled) return;
        setMaster(remoteMaster);
        setMasterSyncError('');
      },
      () => {
        if (!cancelled) refetchMaster();
      }
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Effect A: ambil checklist aktif dari server SEKALI saat mount. State
  // `checklist` di-set dari sini (atau dari cache lokal duluan sebagai initial
  // state, lihat useState di atas).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const serverChecklist = await loadActiveChecklistFromServer(supabase);
        if (cancelled) return;
        setChecklistSyncError('');
        setChecklist((prev) => pickNewerChecklist(serverChecklist, prev));
      } catch (err) {
        if (cancelled) return;
        // Gagal konek — tetap pakai cache lokal, kasih tau user datanya
        // mungkin belum sinkron dengan device lain.
        setChecklistSyncError('Gagal sinkron checklist terbaru, menampilkan data tersimpan di device ini.');
      } finally {
        if (!cancelled) setChecklistLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Effect B: subscribe realtime ke key checklist yang SEDANG aktif (bukan
  // cuma sekali pas mount) — effect ini sengaja depend ke `checklist.key`,
  // supaya kalau key aktif berubah selama komponen masih terbuka (misal
  // checklist di-share lalu device ini lanjut ke checklist baru tanpa reload
  // halaman), koneksi realtime otomatis pindah mendengarkan key yang baru,
  // bukan nyangkut dengerin key lama yang sudah tidak relevan.
  //
  // onResync dipanggil setiap channel (re)connect (termasuk tiap kali sesudah
  // koneksi realtime sempat putus-nyambung) — re-fetch dari server supaya
  // tidak ada perubahan device lain yang KELEWAT selama jendela disconnect.
  // Kalau ternyata ada checklist aktif yang berbeda, setChecklist di sini akan
  // mengubah checklist.key, yang otomatis men-trigger effect ini lagi untuk
  // pindah subscribe ke key yang benar — self-correcting.
  useEffect(() => {
    if (!checklist.key) return;
    let cancelled = false;

    const unsubscribe = subscribeStockChecklist(
      supabase,
      checklist.key,
      (remoteChecklist) => {
        if (cancelled) return;
        setChecklist((prev) => pickNewerChecklist(remoteChecklist, prev));
        setChecklistSyncError('');
      },
      () => {
        if (cancelled) return;
        loadActiveChecklistFromServer(supabase)
          .then((fresh) => {
            if (cancelled) return;
            // GUARD PENTING: fetch reconcile ini bisa saja mulai duluan tapi
            // baru selesai BELAKANGAN (misal koneksi lambat) — kalau user
            // sempat menyelesaikan kategori lain SAAT fetch ini masih
            // berjalan, hasil fetch basi ini TIDAK BOLEH menimpa balik state
            // yang sudah lebih baru. pickNewerChecklist yang menjaga ini.
            setChecklist((prev) => pickNewerChecklist(fresh, prev));
            setChecklistSyncError('');
          })
          .catch(() => {
            if (!cancelled) {
              setChecklistSyncError('Gagal sinkron ulang checklist. Cek koneksi.');
            }
          });
      }
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [checklist.key]);

  // Karyawan biasa gak boleh buka panel kelola — kalau somehow kebuka lalu
  // gantian pilih nama yang bukan admin, tutup paksa panelnya.
  useEffect(() => {
    if (!canManage) setManageOpen(false);
  }, [canManage]);

  const items = allItemsFlat(master);
  const complete = isChecklistComplete(checklist, master);
  const alreadySubmitted = !!checklist.submittedAt;
  const locked = isChecklistLocked(checklist);
  // Gate absen pulang kebuka kalau belum ada item sama sekali, ATAU checklist
  // sudah di-lock (artinya SUDAH ADA karyawan yang submit lengkap ke WA —
  // berlaku untuk semua device, bukan cuma device yang mengirim).
  const gateOpen = items.length === 0 || locked;

  useEffect(() => {
    onGateStatusChange?.({ gateOpen, hasItems: items.length > 0, complete });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateOpen, items.length, complete]);

  useEffect(() => {
    if (!selectedCategoryId && master.categories.length > 0) {
      setSelectedCategoryId(master.categories[0].id);
    }
  }, [master.categories, selectedCategoryId]);

  // Setiap kali pindah kategori (atau checklist berubah dari server/realtime),
  // sinkronkan draft lokal dari nilai tersimpan kategori itu — supaya kalau
  // device lain sudah isi sebagian item kategori ini sebelumnya, draft mulai
  // dari situ, bukan kosong.
  useEffect(() => {
    const cat = master.categories.find((c) => c.id === selectedCategoryId);
    if (!cat) return;
    const next = {};
    for (const it of cat.items) {
      next[it.id] = checklist.values[it.id] || { qty: '', skipped: false };
    }
    setDraftValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategoryId, master.categories, checklist.key]);

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
  // Cuma update state lokal (draft) — TIDAK push ke Supabase per-keystroke.
  // Push beneran terjadi sekali di handleCompleteCategory saat tombol
  // "Selesai" kategori ditekan.
  const handleDraftChange = (itemId, patch) => {
    if (locked) return;
    setDraftValues((prev) => ({
      ...prev,
      [itemId]: { qty: patch.qty ?? '', skipped: !!patch.skipped },
    }));
  };

  // Tandai kategori terpilih selesai: push SEMUA item kategori ini sekaligus
  // (satu RPC atomic), server jadi sumber kebenaran hasil merge-nya.
  const handleCompleteCategory = async (category) => {
    if (locked || savingCategory) return;
    // Validasi lokal dulu — draft sementara dianggap "checklist" utk dicek.
    const draftAsChecklist = { ...checklist, values: { ...checklist.values, ...draftValues } };
    if (!isCategoryFilledComplete(category, draftAsChecklist)) return;

    setSavingCategory(true);
    const optimistic = {
      ...checklist,
      values: { ...checklist.values, ...draftValues },
      categoryDone: { ...checklist.categoryDone, [category.id]: true },
      // Stempel waktu "sekarang" di prediksi optimistic ini, supaya kalau ada
      // respons server basi (misal onResync yang mulai duluan) datang belakangan,
      // dia dianggap LEBIH LAMA dan tidak menimpa prediksi ini sebelum hasil
      // RPC completeCategory yang sebenarnya datang.
      updatedAt: new Date().toISOString(),
    };
    setChecklist(optimistic);
    try {
      const merged = await completeCategory(supabase, checklist, category.id, draftValues);
      setChecklist((prev) => pickNewerChecklist(merged, prev));
      setChecklistSyncError('');
    } catch (err) {
      setChecklistSyncError('Gagal menyimpan kategori ke server. Cek koneksi lalu coba lagi.');
    } finally {
      setSavingCategory(false);
    }
  };

  // Buka lagi kategori yang sudah ditandai selesai supaya bisa dikoreksi,
  // sebelum checklist keseluruhan di-share ke WhatsApp.
  const handleReopenCategory = async (category) => {
    if (locked || savingCategory) return;
    setSavingCategory(true);
    const optimistic = {
      ...checklist,
      categoryDone: { ...checklist.categoryDone, [category.id]: false },
      updatedAt: new Date().toISOString(),
    };
    setChecklist(optimistic);
    try {
      const merged = await reopenCategory(supabase, checklist, category.id);
      setChecklist((prev) => pickNewerChecklist(merged, prev));
      setChecklistSyncError('');
    } catch (err) {
      setChecklistSyncError('Gagal membuka kategori. Cek koneksi lalu coba lagi.');
    } finally {
      setSavingCategory(false);
    }
  };

  const handleSubmit = async () => {
    // Agung Prayoga boleh bypass kelengkapan checklist (misal buru-buru / item
    // fisiknya belum sempat dicek semua) — selain dia, tetap wajib complete dulu.
    if ((!complete && !canBypassChecklist) || locked) return;
    const optimistic = {
      ...checklist,
      submittedAt: new Date().toISOString(),
      submittedBy: currentEmployeeName || null,
      updatedAt: new Date().toISOString(),
    };
    setChecklist(optimistic);
    try {
      const saved = await submitChecklist(supabase, checklist, currentEmployeeName);
      setChecklist((prev) => pickNewerChecklist(saved, prev));
      setChecklistSyncError('');
    } catch (err) {
      setChecklistSyncError('Gagal menyimpan checklist ke server. Cek koneksi lalu coba lagi.');
    }
  };

  const handleShare = async () => {
    if (locked) return;
    const text = formatWhatsAppText(checklist, master);
    window.open(buildWhatsAppShareUrl(text), '_blank');
    setJustShared(true);
    try {
      const saved = await markShared(supabase, checklist);
      setChecklist((prev) => pickNewerChecklist(saved, prev)); // locked=true — otomatis kebuka gate absen di device ini,
      setChecklistSyncError(''); // dan lewat realtime, di semua device lain juga.
    } catch (err) {
      setChecklistSyncError('Gagal mengunci checklist di server. Coba tekan bagikan lagi.');
    }
  };

  // Dipakai SETELAH checklist locked — beda dari handleShare karena di sini
  // TIDAK perlu panggil markShared/RPC lagi (checklist sudah locked, values
  // juga tidak berubah). Ini murni buka ulang teks WA yang sama dari data
  // checklist yang sudah tersimpan, supaya bisa dibagikan ulang kapan saja
  // tanpa batas (misal ada yang minta dikirim ulang, atau grup WA beda).
  const handleShareAgain = async () => {
    if (shareAgainLoading) return;
    // Guard: kalau state `checklist` di device ini ternyata gak punya isian
    // sama sekali padahal statusnya locked (harusnya mustahil buat checklist
    // yang beneran sudah di-share — locked hanya terjadi setelah ada isian),
    // ini tanda state lokal kena race/basi (lihat pickNewerChecklist). Fetch
    // ulang dulu dari server sebelum generate teks, supaya gak pernah buka
    // WhatsApp dengan pesan kosong.
    if (Object.keys(checklist.values || {}).length === 0) {
      setShareAgainLoading(true);
      try {
        const fresh = await loadActiveChecklistFromServer(supabase);
        setChecklist((prev) => pickNewerChecklist(fresh, prev));
        const text = formatWhatsAppText(fresh, master);
        window.open(buildWhatsAppShareUrl(text), '_blank');
      } catch (err) {
        setChecklistSyncError('Gagal mengambil data checklist. Cek koneksi lalu coba lagi.');
      } finally {
        setShareAgainLoading(false);
      }
      return;
    }
    const text = formatWhatsAppText(checklist, master);
    window.open(buildWhatsAppShareUrl(text), '_blank');
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
              {masterLoading || checklistLoading
                ? 'Memuat data stock...'
                : items.length === 0
                ? 'Belum ada item — tap untuk tambah'
                : locked
                ? checklist.submittedBy
                  ? `Sudah diisi ${checklist.submittedBy} & dibagikan, absen pulang terbuka`
                  : 'Sudah dibagikan ke grup, absen pulang terbuka'
                : alreadySubmitted
                ? 'Sudah diisi, tinggal bagikan ke WhatsApp'
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

          {checklistSyncError && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3.5 py-2.5">
              <WifiOff className="w-4 h-4 text-red-500 shrink-0" />
              <p className="text-xs text-red-600 font-medium leading-relaxed">{checklistSyncError}</p>
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

          {items.length > 0 && !locked && (
            <>
              {/* Dropdown kategori — tiap opsi nampilin progress item wajib & status selesai */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-stone-500 block">Kategori</label>
                <select
                  value={selectedCategoryId}
                  onChange={(e) => setSelectedCategoryId(e.target.value)}
                  className="w-full border border-stone-200 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
                >
                  {master.categories.map((c) => {
                    const { filled, total } = categoryRequiredProgress(c, checklist);
                    const done = !!checklist.categoryDone?.[c.id];
                    const label =
                      total === 0
                        ? `${c.name} (${c.items.length})`
                        : `${c.name} — ${done ? '✓ Selesai' : `${filled}/${total} wajib`}`;
                    return (
                      <option key={c.id} value={c.id}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* Kategori terpilih: kalau sudah "Selesai" tampilkan ringkasan +
                  tombol Edit lagi; kalau belum, tampilkan form isi item + tombol Selesai. */}
              {selectedCategory && (() => {
                const catDone = !!checklist.categoryDone?.[selectedCategory.id];
                const { filled, total } = categoryRequiredProgress(selectedCategory, checklist);
                const draftAsChecklist = { ...checklist, values: { ...checklist.values, ...draftValues } };
                const canCompleteThisCategory = isCategoryFilledComplete(selectedCategory, draftAsChecklist);

                if (catDone) {
                  return (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-3.5 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                          <span className="text-xs font-bold text-green-700">
                            Kategori ini sudah selesai diisi
                          </span>
                        </div>
                        <button
                          onClick={() => handleReopenCategory(selectedCategory)}
                          disabled={savingCategory}
                          className="text-[11px] font-bold text-orange-600 bg-white px-2.5 py-1.5 rounded-lg border border-orange-200 disabled:opacity-50 shrink-0"
                        >
                          Edit lagi
                        </button>
                      </div>
                      <div className="space-y-1.5">
                        {selectedCategory.items.map((it) => {
                          const v = checklist.values[it.id];
                          const filledV = v && v.qty !== null && v.qty !== '';
                          return (
                            <div key={it.id} className="flex items-center justify-between text-xs px-1">
                              <span className="text-stone-600 truncate">{it.name}</span>
                              <span className="font-medium text-stone-800 shrink-0 ml-2">
                                {filledV ? `${v.qty} ${it.unit || ''}`.trim() : '—'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="space-y-2.5">
                    {total > 0 && (
                      <div className="flex items-center gap-2 bg-stone-50 border border-stone-200 rounded-xl px-3.5 py-2">
                        <span className="text-[11px] font-bold text-stone-500">
                          {filled}/{total} item wajib terisi
                        </span>
                      </div>
                    )}
                    {selectedCategory.items.length === 0 && (
                      <p className="text-xs text-stone-400 italic">Belum ada item di kategori ini.</p>
                    )}
                    {selectedCategory.items.map((it) => {
                      const v = draftValues[it.id];
                      const filledV = v && v.qty !== null && v.qty !== '';
                      return (
                        <div
                          key={it.id}
                          className={`rounded-2xl border px-3.5 py-3 ${
                            filledV ? 'border-green-200 bg-green-50/40' : 'border-stone-200'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {filledV ? (
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
                              onChange={(e) =>
                                handleDraftChange(it.id, { qty: e.target.value, skipped: false })
                              }
                              className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                            />
                            <span className="text-xs text-stone-400 w-14 shrink-0">{it.unit || '-'}</span>
                          </div>
                        </div>
                      );
                    })}

                    {!canCompleteThisCategory && selectedCategory.items.length > 0 && (
                      <p className="text-[11px] text-amber-600 text-center">
                        Lengkapi semua item wajib di kategori ini dulu untuk menandai selesai.
                      </p>
                    )}

                    {selectedCategory.items.length > 0 && (
                      <button
                        onClick={() => handleCompleteCategory(selectedCategory)}
                        disabled={!canCompleteThisCategory || savingCategory}
                        className="w-full bg-stone-800 disabled:bg-stone-200 disabled:text-stone-400 text-white font-bold py-2.5 rounded-xl transition text-sm"
                      >
                        {savingCategory ? 'Menyimpan...' : 'Selesai Kategori Ini'}
                      </button>
                    )}
                  </div>
                );
              })()}

              {!complete && !canBypassChecklist && (
                <p className="text-[11px] text-amber-600 text-center">
                  Selesaikan semua kategori wajib dulu untuk bisa lanjut bagikan ke WhatsApp.
                </p>
              )}

              {!complete && canBypassChecklist && (
                <p className="text-[11px] text-orange-600 text-center font-medium">
                  Kategori wajib belum semua selesai, tapi kamu bisa lanjutkan (khusus Agung Prayoga).
                </p>
              )}

              {!alreadySubmitted ? (
                <button
                  onClick={handleSubmit}
                  disabled={!complete && !canBypassChecklist}
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

          {locked && (
            <div className="text-center py-2">
              <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2" />
              <p className="text-sm font-medium text-stone-700">
                Checklist sudah dibagikan{checklist.submittedBy ? ` oleh ${checklist.submittedBy}` : ''}
              </p>
              <p className="text-xs text-stone-400 mt-0.5">
                {justShared
                  ? 'Berhasil dibuka di WhatsApp.'
                  : checklist.sharedAt
                  ? `Terkirim ${new Date(checklist.sharedAt).toLocaleString('id-ID')}`
                  : 'Form ini sudah dikunci, absen pulang terbuka.'}
              </p>
              {/* Hasil checklist tetap tersimpan di server walau sudah locked,
                  jadi tombol ini bisa dipencet berkali-kali kapan saja untuk
                  bagikan ulang teks yang sama — tanpa mengubah data / status. */}
              <button
                onClick={handleShareAgain}
                disabled={shareAgainLoading}
                className="mt-3 mx-auto flex items-center justify-center gap-2 text-sm font-bold text-green-700 bg-green-50 hover:bg-green-100 disabled:opacity-60 px-4 py-2 rounded-xl transition"
              >
                {shareAgainLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Share2 className="w-4 h-4" />
                )}
                {shareAgainLoading ? 'Mengambil data...' : 'Bagikan Lagi ke WhatsApp'}
              </button>
            </div>
          )}

          {canManage && (
            <div className="pt-1 border-t border-stone-100">
              <button
                onClick={() => setManageOpen(true)}
                className="w-full flex items-center justify-center gap-1.5 text-xs font-bold text-stone-500 py-2"
              >
                <ListPlus className="w-3.5 h-3.5" /> Kelola Kategori & Item
              </button>
            </div>
          )}
        </div>
      )}

      {canManage && manageOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center"
          onClick={() => setManageOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white w-full sm:max-w-lg sm:rounded-3xl rounded-t-3xl max-h-[85vh] flex flex-col overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100 shrink-0">
              <p className="text-sm font-bold text-stone-800">Kelola Kategori & Item</p>
              <button
                onClick={() => setManageOpen(false)}
                className="w-8 h-8 rounded-full bg-stone-100 flex items-center justify-center text-stone-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              <ManageStockMaster master={master} onChange={refreshMaster} />
            </div>
          </div>
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