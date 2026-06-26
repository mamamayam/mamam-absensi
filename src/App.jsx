import { useState, useEffect, useRef, Fragment } from 'react';
import {
  User, Camera, MapPin, CheckCircle2, AlertTriangle,
  ChevronLeft, ChevronRight, Loader2, RotateCcw, Flame,
  LogOut, ShieldCheck, Search, Coffee,
} from 'lucide-react';
import { supabase, isConfigured } from './supabase.js';
import { getTodayStr, formatTime, generateId, distanceMeters, compressImage } from './utils.js';

// TODO: ganti 3 angka ini dengan koordinat outlet ASLI kamu.
// Caranya: buka Google Maps, klik kanan tepat di lokasi outlet, klik angka
// koordinat yang muncul di menu (otomatis ter-copy), tempel di sini.
// Placeholder sekarang masih koordinat Kemang, Jakarta Selatan (cuma contoh).
const OUTLET_LAT = Number(import.meta.env.VITE_OUTLET_LAT) || -6.2607;
const OUTLET_LNG = Number(import.meta.env.VITE_OUTLET_LNG) || 106.8133;
const OUTLET_RADIUS_M = Number(import.meta.env.VITE_OUTLET_RADIUS_M) || 50;

const PHOTO_BUCKET = 'attendance-photos';

// 3 langkah: Nama → Selfie → Lokasi (tanpa OTP, tanpa PIN)
const STEPS = [
  { id: 1, label: 'Nama', icon: User },
  { id: 2, label: 'Selfie', icon: Camera },
  { id: 3, label: 'Lokasi', icon: MapPin },
];

function CenteredMessage({ children }) {
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-stone-50 p-4 text-center gap-2">
      {children}
    </div>
  );
}

/**
 * App — root. Cuma ngurus loading data karyawan + cek konfigurasi Supabase,
 * baru lempar ke EmployeeFlow kalau semua siap.
 */
export default function App() {
  const [appStep, setAppStep] = useState('loading'); // loading | form | config-error
  const [employees, setEmployees] = useState([]);
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    if (!isConfigured()) {
      setAppStep('config-error');
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'employees')
        .maybeSingle();

      if (error) {
        setLoadErr('Gagal memuat data karyawan. Coba refresh halaman ini.');
        setAppStep('config-error');
        return;
      }
      const list = Array.isArray(data?.value) ? data.value : [];
      setEmployees(list.filter((e) => !e.deletedAt));
      setAppStep('form');
    })();
  }, []);

  if (appStep === 'loading') {
    return (
      <CenteredMessage>
        <Loader2 className="w-6 h-6 animate-spin text-stone-400" />
        <p className="text-xs text-stone-400">Memuat...</p>
      </CenteredMessage>
    );
  }

  if (appStep === 'config-error') {
    return (
      <CenteredMessage>
        <AlertTriangle className="w-9 h-9 text-red-400" />
        <p className="text-sm font-bold text-stone-700">Belum bisa terhubung</p>
        <p className="text-xs text-stone-400">{loadErr || 'Konfigurasi server belum diatur. Hubungi admin toko.'}</p>
      </CenteredMessage>
    );
  }

  return <EmployeeFlow employees={employees} />;
}

/**
 * EmployeeFlow — stepper 3 langkah (Nama → Selfie → Lokasi).
 * Tidak ada PIN, tidak ada OTP. Berlaku untuk semua tipe absen:
 * masuk, jam bolong (ijin keluar sementara), maupun pulang.
 */
function EmployeeFlow({ employees }) {
  const [step, setStep] = useState(1);
  const [absenType, setAbsenType] = useState('masuk');

  // Step 1 — pilih nama
  const [search, setSearch] = useState('');
  const [employee, setEmployee] = useState(null);
  const [todayStatus, setTodayStatus] = useState(null); // { hasMasuk, hasKeluar, lastType }
  const [checkingStatus, setCheckingStatus] = useState(false);

  // Step 2 — selfie
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const fileInputRef = useRef(null);

  // Step 3 — GPS
  const [gpsStatus, setGpsStatus] = useState('idle'); // idle | checking | near | far | denied
  const [distance, setDistance] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState(null); // { type, time, flagged }

  // --- Step 1: cari & pilih nama ---
  const filteredEmployees = employees.filter((e) =>
    e.name?.toLowerCase().includes(search.trim().toLowerCase())
  );

  const handlePickEmployee = async (emp) => {
    setEmployee(emp);
    setSearch(''); // tutup list setelah pilih nama
    setSubmitError('');
    setCheckingStatus(true);
    setTodayStatus(null);
    try {
      const todayStr = getTodayStr();
      const { data: rows } = await supabase
        .from('attendanceLog')
        .select('payload')
        .eq('payload->>employeeId', emp.id)
        .eq('payload->>dateStr', todayStr);

      const activeToday = (rows ?? []).map((r) => r.payload).filter((p) => !p.deletedAt);
      const sorted = activeToday.sort((a, b) => new Date(a.date) - new Date(b.date));
      const lastRecord = sorted[sorted.length - 1];
      const lastType = lastRecord?.type ?? null;
      const hasMasuk = activeToday.some((p) => p.type === 'masuk');
      const hasKeluar = activeToday.some((p) => p.type === 'keluar');
      setTodayStatus({ hasMasuk, hasKeluar, lastType });

      // Default tipe absen berdasarkan state terakhir
      if (!lastType || lastType === 'bolong') setAbsenType('masuk');
      else if (lastType === 'masuk') setAbsenType('keluar');
    } finally {
      setCheckingStatus(false);
    }
  };

  // --- Step 2: selfie ---
  const handlePickPhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  // --- Step 3: GPS ---
  const checkGps = () => {
    if (!navigator.geolocation) {
      setGpsStatus('denied');
      return;
    }
    setGpsStatus('checking');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const d = Math.round(
          distanceMeters(pos.coords.latitude, pos.coords.longitude, OUTLET_LAT, OUTLET_LNG)
        );
        setDistance(d);
        setGpsStatus(d <= OUTLET_RADIUS_M ? 'near' : 'far');
      },
      () => setGpsStatus('denied'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Auto-scan GPS begitu masuk step 3
  useEffect(() => {
    if (step === 3 && gpsStatus === 'idle') checkGps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const sudahLengkapHariIni = todayStatus?.lastType === 'keluar';

  const canNext = {
    1: !!employee && !checkingStatus && !sudahLengkapHariIni,
    2: !!photoFile,
    3: gpsStatus === 'near',
  };

  const handleSubmit = async () => {
    if (gpsStatus !== 'near') {
      setSubmitError(`Lokasi terlalu jauh. Kamu harus dalam radius ${OUTLET_RADIUS_M}m dari outlet untuk bisa absen.`);
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      // Cek status hari ini (bisa berubah selama proses absen jalan)
      const todayStr = getTodayStr();
      const { data: rows, error: logErr } = await supabase
        .from('attendanceLog')
        .select('payload')
        .eq('payload->>employeeId', employee.id)
        .eq('payload->>dateStr', todayStr);

      if (logErr) {
        setSubmitError('Gagal mengecek riwayat absen. Coba lagi sebentar.');
        return;
      }
      const activeToday = (rows ?? []).map((r) => r.payload).filter((p) => !p.deletedAt);
      const sorted = activeToday.sort((a, b) => new Date(a.date) - new Date(b.date));
      const lastType = sorted[sorted.length - 1]?.type ?? null;
      const hasMasuk = activeToday.some((p) => p.type === 'masuk');
      const hasKeluar = activeToday.some((p) => p.type === 'keluar');

      // Validasi transisi state
      if (absenType === 'masuk' && lastType === 'masuk') {
        setSubmitError('Kamu sudah absen masuk dan masih bekerja.');
        return;
      }
      if (absenType === 'masuk' && lastType === 'keluar') {
        setSubmitError('Kamu sudah selesai kerja hari ini.');
        return;
      }
      if (absenType === 'bolong') {
        if (lastType !== 'masuk') {
          setSubmitError(
            !lastType ? 'Belum absen masuk, tidak bisa ijin bolong.' :
              lastType === 'bolong' ? 'Masih dalam jam bolong, absen masuk dulu.' :
                'Tidak bisa ijin bolong setelah absen keluar.',
          );
          return;
        }
      }
      if (absenType === 'keluar') {
        if (!hasMasuk) {
          setSubmitError('Belum absen masuk, jadi belum bisa absen keluar.');
          return;
        }
        if (lastType === 'bolong') {
          setSubmitError('Absen masuk dulu setelah jam bolong sebelum bisa pulang.');
          return;
        }
        if (hasKeluar) {
          setSubmitError('Kamu sudah absen keluar hari ini.');
          return;
        }
      }

      // Upload foto (kompres dulu) — kalau gagal, absen tetap lanjut tanpa foto
      let photoUrl = null;
      try {
        const compressed = await compressImage(photoFile);
        const fileName = `${todayStr}/${employee.id}-${absenType}-${Date.now()}.jpg`;
        const { error: uploadErr } = await supabase.storage
          .from(PHOTO_BUCKET)
          .upload(fileName, compressed, { contentType: 'image/jpeg' });
        if (!uploadErr) {
          const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(fileName);
          photoUrl = pub?.publicUrl ?? null;
        }
      } catch (_) {
        // foto opsional, jangan blokir absen
      }

      // Simpan record absen
      const flagged = gpsStatus === 'far';
      const nowIso = new Date().toISOString();
      const recordId = generateId();

      const { error: insertErr } = await supabase.from('attendanceLog').upsert(
        {
          id: recordId,
          payload: {
            id: recordId,
            employeeId: employee.id,
            employeeName: employee.name,
            type: absenType,
            date: nowIso,
            dateStr: todayStr,
            photoUrl,
            location: { distance, flagged },
            deletedAt: null,
          },
          updated_at: nowIso,
          updated_by: 'web-absensi',
        },
        { onConflict: 'id' }
      );

      if (insertErr) {
        setSubmitError('Gagal menyimpan absen. Coba lagi sebentar.');
        return;
      }

      setDone({ type: absenType, time: nowIso, flagged });
    } catch (_) {
      setSubmitError('Ada gangguan koneksi. Coba lagi sebentar.');
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setStep(1);
    setEmployee(null);
    setSearch('');
    setTodayStatus(null);
    setAbsenType('masuk');
    setPhotoFile(null);
    setPhotoPreview(null);
    setGpsStatus('idle');
    setDistance(null);
    setDone(null);
    setSubmitError('');
  };

  // ── Layar sukses ──────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="h-screen bg-stone-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl shadow-xl max-w-sm w-full p-8 text-center">
          <div
            className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${done.type === 'bolong' ? 'bg-amber-100' : done.flagged ? 'bg-amber-100' : 'bg-green-100'
              }`}
          >
            {done.type === 'bolong' ? (
              <Coffee className="w-9 h-9 text-amber-600" />
            ) : done.flagged ? (
              <AlertTriangle className="w-9 h-9 text-amber-600" />
            ) : (
              <CheckCircle2 className="w-9 h-9 text-green-600" />
            )}
          </div>
          <h2 className="text-xl font-bold text-stone-800 mb-1">
            {done.type === 'masuk' ? 'Absen Masuk Tercatat' :
              done.type === 'bolong' ? 'Jam Bolong Tercatat' :
                'Absen Pulang Tercatat'}
          </h2>
          <p className="text-stone-500 text-sm font-mono mb-1">{formatTime(done.time)} WIB</p>
          {done.flagged && (
            <p className="text-xs text-amber-600 mb-1">lokasi ditandai untuk ditinjau admin</p>
          )}
          <div className="bg-stone-50 rounded-2xl p-4 text-left space-y-2 mb-6 mt-4">
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">Nama</span>
              <span className="font-medium text-stone-800">{employee?.name}</span>
            </div>
            {distance != null && (
              <div className="flex justify-between text-sm">
                <span className="text-stone-500">Lokasi</span>
                <span className={`font-mono ${done.flagged ? 'text-amber-600' : 'text-green-600'}`}>
                  {distance}m {done.flagged ? '⚠' : '✓'}
                </span>
              </div>
            )}
          </div>
          <button
            onClick={reset}
            className="w-full bg-orange-600 hover:bg-orange-700 text-white font-medium py-3 rounded-xl transition"
          >
            Absen Lagi
          </button>
        </div>
      </div>
    );
  }

  // ── Layar form ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
      <div className="max-w-sm w-full">
        <div className="bg-stone-900 rounded-t-3xl p-5">
          <div className="flex items-center justify-center gap-2 mb-1">
            <Flame className="w-5 h-5 text-orange-500" />
            <span className="font-bold text-lg text-white">
              Mamam <span className="text-orange-500">Ayam</span>
            </span>
          </div>
          <p className="text-stone-400 text-sm text-center">Absen Pegawai Mamam Ayam</p>
        </div>

        <div className="relative h-0">
          <div className="absolute left-0 right-0 top-0 border-t-2 border-dashed border-stone-300" />
          <div className="absolute left-4 top-0 -translate-y-1/2 w-3 h-3 rounded-full bg-stone-50" />
          <div className="absolute right-4 top-0 -translate-y-1/2 w-3 h-3 rounded-full bg-stone-50" />
        </div>

        <div className="bg-white rounded-b-3xl shadow-xl p-5 pt-6">
          {/* Pilihan tipe absen — dinamis sesuai status karyawan */}
          {todayStatus?.lastType === 'masuk' && !sudahLengkapHariIni && (
            <div className="flex bg-stone-100 rounded-xl p-1 mb-5">
              <button
                onClick={() => setAbsenType('bolong')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition ${absenType === 'bolong' ? 'bg-white shadow text-amber-700' : 'text-stone-500'
                  }`}
              >
                <Coffee className="w-4 h-4" /> Jam Bolong
              </button>
              <button
                onClick={() => setAbsenType('keluar')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition ${absenType === 'keluar' ? 'bg-white shadow text-orange-700' : 'text-stone-500'
                  }`}
              >
                <LogOut className="w-4 h-4" /> Pulang
              </button>
            </div>
          )}
          {todayStatus?.lastType === 'bolong' && !sudahLengkapHariIni && (
            <div className="flex items-center gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-3 mb-5">
              <Coffee className="w-4 h-4 text-amber-600 shrink-0" />
              <p className="text-xs text-amber-700 font-medium leading-relaxed">
                Kamu sedang dalam <span className="font-bold">jam bolong</span>. Absen masuk lagi untuk melanjutkan kerja.
              </p>
            </div>
          )}

          {/* Progress steps */}
          <div className="flex items-center justify-center mb-6">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const active = step === s.id;
              const completed = step > s.id;
              return (
                <Fragment key={s.id}>
                  {/* Lingkaran Ikon */}
                  <div
                    className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center transition ${completed
                        ? 'bg-green-500 text-white'
                        : active
                          ? 'bg-orange-600 text-white'
                          : 'bg-stone-100 text-stone-400'
                      }`}
                  >
                    {completed ? <CheckCircle2 className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                  </div>

                  {/* Garis Penghubung */}
                  {i < STEPS.length - 1 && (
                    <div className={`w-12 h-0.5 mx-2 ${completed ? 'bg-green-500' : 'bg-stone-100'}`} />
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Step 1: Pilih Nama */}
          {step === 1 && (
            <div className="space-y-3">
              <label className="text-sm font-medium text-stone-700 block">Pilih Nama Kamu</label>
              <div className="relative">
                <Search className="w-4 h-4 text-stone-300 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Cari nama..."
                  className="w-full pl-9 border border-stone-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div className="space-y-1.5 max-h-52 overflow-y-auto">
                {search.trim() === '' ? (
                  employee && (
                    <button
                      key={employee.id}
                      className="w-full text-left px-4 py-3 rounded-xl border border-orange-500 bg-orange-50 text-orange-700 text-sm font-medium"
                    >
                      {employee.name}
                    </button>
                  )
                ) : (
                  <>
                    {filteredEmployees.length === 0 && (
                      <p className="text-xs text-stone-400 text-center py-4">
                        {employees.length === 0 ? 'Belum ada data karyawan.' : 'Nama tidak ditemukan.'}
                      </p>
                    )}
                    {filteredEmployees.map((emp) => (
                      <button
                        key={emp.id}
                        onClick={() => handlePickEmployee(emp)}
                        className={`w-full text-left px-4 py-3 rounded-xl border text-sm font-medium transition ${employee?.id === emp.id
                            ? 'border-orange-500 bg-orange-50 text-orange-700'
                            : 'border-stone-200 text-stone-700 hover:bg-stone-50'
                          }`}
                      >
                        {emp.name}
                      </button>
                    ))}
                  </>
                )}
              </div>

              {checkingStatus && (
                <div className="flex items-center gap-1.5 text-xs text-stone-400">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Mengecek status absen hari ini...
                </div>
              )}
              {sudahLengkapHariIni && (
                <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Kamu sudah absen masuk & pulang hari ini.
                </div>
              )}
            </div>
          )}

          {/* Step 2: Selfie */}
          {step === 2 && (
            <div className="space-y-4">
              <label className="text-sm font-medium text-stone-700 block">Foto Selfie</label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="user"
                onChange={handlePickPhoto}
                className="hidden"
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-56 bg-stone-50 border-2 border-dashed border-stone-200 rounded-2xl flex flex-col items-center justify-center relative overflow-hidden cursor-pointer"
              >
                {photoPreview ? (
                  <>
                    <img src={photoPreview} alt="Selfie" className="w-full h-full object-cover" />
                    <div className="absolute top-2 right-2 bg-green-500 rounded-full p-1">
                      <CheckCircle2 className="w-4 h-4 text-white" />
                    </div>
                  </>
                ) : (
                  <>
                    <Camera className="w-10 h-10 text-stone-300 mb-2" />
                    <span className="text-stone-400 text-sm">Ketuk untuk buka kamera</span>
                  </>
                )}
              </div>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full border border-orange-600 text-orange-700 font-medium py-2.5 rounded-xl flex items-center justify-center gap-2 hover:bg-orange-50 transition"
              >
                {photoPreview ? (
                  <>
                    <RotateCcw className="w-4 h-4" /> Ambil Ulang
                  </>
                ) : (
                  <>
                    <Camera className="w-4 h-4" /> Ambil Foto
                  </>
                )}
              </button>
              <p className="text-xs text-stone-400 text-center">
                Kalau kamera tidak terbuka, pastikan kamu sudah mengizinkan akses kamera untuk browser ini.
              </p>
            </div>
          )}

          {/* Step 3: Lokasi */}
          {step === 3 && (
            <div className="space-y-4">
              <label className="text-sm font-medium text-stone-700 block">Verifikasi Lokasi</label>
              <div
                className={`rounded-2xl p-5 flex flex-col items-center text-center gap-2 ${gpsStatus === 'checking' || gpsStatus === 'idle'
                    ? 'bg-stone-50'
                    : gpsStatus === 'near'
                      ? 'bg-green-50'
                      : 'bg-red-50'
                  }`}
              >
                {(gpsStatus === 'checking' || gpsStatus === 'idle') && (
                  <>
                    <Loader2 className="w-8 h-8 text-stone-400 animate-spin" />
                    <span className="text-sm text-stone-500">Mengecek lokasi GPS...</span>
                  </>
                )}
                {gpsStatus === 'near' && (
                  <>
                    <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                      <MapPin className="w-6 h-6 text-green-600" />
                    </div>
                    <span className="text-sm font-mono font-medium text-green-700">{distance}m dari outlet</span>
                    <span className="text-xs text-green-600">lokasi terverifikasi</span>
                  </>
                )}
                {gpsStatus === 'far' && (
                  <>
                    <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                      <AlertTriangle className="w-6 h-6 text-red-600" />
                    </div>
                    <span className="text-sm font-mono font-medium text-red-700">{distance}m dari outlet</span>
                    <span className="text-xs text-red-600">terlalu jauh, tidak bisa absen</span>
                    <button onClick={checkGps} className="text-xs text-orange-600 font-bold underline mt-1">
                      Cek ulang lokasi
                    </button>
                  </>
                )}
                {gpsStatus === 'denied' && (
                  <>
                    <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                      <AlertTriangle className="w-6 h-6 text-red-600" />
                    </div>
                    <span className="text-sm font-medium text-red-700">Izin lokasi ditolak</span>
                    <button onClick={checkGps} className="text-xs text-orange-600 font-bold underline">
                      Coba lagi
                    </button>
                  </>
                )}
              </div>
              <p className="text-xs text-stone-400 text-center">
                Kamu harus berada dalam radius {OUTLET_RADIUS_M}m dari outlet untuk bisa absen.
              </p>
            </div>
          )}

          {/* Navigasi */}
          <div className="flex gap-2 mt-6">
            {step > 1 && (
              <button
                onClick={() => setStep(step - 1)}
                className="px-4 py-3 rounded-xl border border-stone-200 text-stone-500 hover:bg-stone-50"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={() => setStep(step + 1)}
                disabled={!canNext[step]}
                className="flex-1 bg-orange-600 disabled:bg-stone-200 disabled:text-stone-400 text-white font-medium py-3 rounded-xl flex items-center justify-center gap-1.5 transition"
              >
                Lanjut <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!canNext[3] || submitting}
                className="flex-1 bg-orange-600 disabled:bg-stone-200 disabled:text-stone-400 text-white font-medium py-3 rounded-xl flex items-center justify-center gap-1.5 transition"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" /> Catat Absen
                  </>
                )}
              </button>
            )}
          </div>

          {submitError && step === 3 && (
            <div className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg mt-3">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {submitError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}