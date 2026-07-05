import { useState, useEffect, useRef, Fragment } from 'react';
import {
  User, Camera, MapPin, CheckCircle2, AlertTriangle,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp,
  Loader2, RotateCcw, Flame, LogOut, ShieldCheck, Coffee,
  Info, Zap, Calendar, Phone, Ban, FileText, Clock,
} from 'lucide-react';
import { supabase, isConfigured } from './supabase.js';
import { getTodayStr, formatTime, generateId, distanceMeters, compressImage } from './utils.js';
import StockChecklistCard from './StockChecklist.jsx';

// TODO: ganti 3 angka ini dengan koordinat outlet ASLI kamu.
const OUTLET_LAT = Number(import.meta.env.VITE_OUTLET_LAT) || -6.2607;
const OUTLET_LNG = Number(import.meta.env.VITE_OUTLET_LNG) || 106.8133;
const OUTLET_RADIUS_M = Number(import.meta.env.VITE_OUTLET_RADIUS_M) || 50;

const PHOTO_BUCKET = 'attendance-photos';

const STEPS = [
  { id: 1, label: 'Nama', icon: User },
  { id: 2, label: 'Selfie', icon: Camera },
  { id: 3, label: 'Lokasi', icon: MapPin },
];

// ── Ketentuan Kerja ───────────────────────────────────────────────────────────
const WORK_RULES = [
  {
    Icon: Clock,
    color: 'blue',
    title: 'Jam Kerja Normal',
    desc: 'Jam kerja berlaku dari pukul 09.00 – 19.00 WIB.',
  },
  {
    Icon: Zap,
    color: 'amber',
    title: 'Lembur',
    desc: 'Lembur dihitung jika absen masuk ≤ 08.30 atau absen pulang ≥ 19.30. Upah: Rp 5.000 per 30 menit.',
  },
  {
    Icon: MapPin,
    color: 'green',
    title: 'Radius Absen',
    desc: `Absen hanya dapat dilakukan dalam jangkauan kurang dari ${OUTLET_RADIUS_M} meter dari outlet.`,
  },
  {
    Icon: Coffee,
    color: 'orange',
    title: 'Jam Bolong (Break)',
    desc: 'Gunakan absen Jam Bolong jika keluar sementara di tengah shift. Jika tidak absen Masuk Lagi setelahnya, jam kerja hanya dihitung sampai waktu Jam Bolong terakhir.',
  },
  {
    Icon: Calendar,
    color: 'red',
    title: 'Tidak Absen = Hari Libur',
    desc: 'Jika tidak ada absen masuk pada hari kerja, sistem otomatis mencatat hari tersebut sebagai hari libur.',
  },
  {
    Icon: Ban,
    color: 'rose',
    title: 'Dilarang Titip Absen',
    desc: 'Absen harus dilakukan sendiri. Menitipkan atau meminta diabsenkan orang lain merupakan pelanggaran berat.',
  },
  {
    Icon: Camera,
    color: 'purple',
    title: 'Foto Selfie',
    desc: 'Pastikan wajah terlihat jelas saat foto diambil. Dilarang menggunakan milik orang lain.',
  },
  {
    Icon: Phone,
    color: 'indigo',
    title: 'Ada Perubahan?',
    desc: 'Untuk koreksi data, perubahan jam, atau ketentuan lainnya, segera hubungi admin/owner.',
  },
];

const COLOR_MAP = {
  blue:   { icon: 'text-blue-600',   bg: 'bg-blue-50'   },
  amber:  { icon: 'text-amber-600',  bg: 'bg-amber-50'  },
  green:  { icon: 'text-green-600',  bg: 'bg-green-50'  },
  orange: { icon: 'text-orange-600', bg: 'bg-orange-50' },
  red:    { icon: 'text-red-600',    bg: 'bg-red-50'    },
  rose:   { icon: 'text-rose-600',   bg: 'bg-rose-50'   },
  purple: { icon: 'text-purple-600', bg: 'bg-purple-50' },
  teal:   { icon: 'text-teal-600',   bg: 'bg-teal-50'   },
  indigo: { icon: 'text-indigo-600', bg: 'bg-indigo-50' },
};

// ── Live Clock ────────────────────────────────────────────────────────────────
function LiveClock() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const dateStr = `${DAYS[time.getDay()]}, ${time.getDate()} ${MONTHS[time.getMonth()]} ${time.getFullYear()}`;

  return (
    <div className="text-center mt-3 mb-1">
      <p className="font-mono text-3xl font-bold text-white tracking-wider tabular-nums">
        {timeStr}
        <span className="text-orange-400 text-sm font-medium ml-2">WIB</span>
      </p>
      <p className="text-stone-400 text-xs mt-1">{dateStr}</p>
    </div>
  );
}

// ── Ketentuan Kerja Card ──────────────────────────────────────────────────────
function WorkRulesCard() {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-white rounded-3xl shadow-lg overflow-hidden mt-3 mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-orange-100 rounded-xl flex items-center justify-center">
            <Info className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <p className="text-sm font-bold text-stone-800">Ketentuan Kerja</p>
            <p className="text-xs text-stone-400">{WORK_RULES.length} ketentuan berlaku · Tap untuk baca</p>
          </div>
        </div>
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
            open ? 'bg-orange-100' : 'bg-stone-100'
          }`}
        >
          {open
            ? <ChevronUp className="w-4 h-4 text-orange-600" />
            : <ChevronDown className="w-4 h-4 text-stone-500" />
          }
        </div>
      </button>

      {open && (
        <>
          <div className="border-t border-stone-100 px-5 pt-4 pb-5 space-y-4">
            {WORK_RULES.map(({ Icon, color, title, desc }, i) => {
              const c = COLOR_MAP[color] || COLOR_MAP.blue;
              return (
                <div key={i} className="flex gap-3 items-start">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${c.bg}`}>
                    <Icon className={`w-4 h-4 ${c.icon}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-stone-700">{title}</p>
                    <p className="text-xs text-stone-500 leading-relaxed mt-0.5">{desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="bg-orange-50 border-t border-orange-100 px-5 py-3 text-center">
            <p className="text-xs text-stone-500">Ketentuan dapat berubah sewaktu-waktu.</p>
            <p className="text-xs font-semibold text-orange-600 mt-0.5">Hubungi admin / owner untuk info terbaru.</p>
          </div>
        </>
      )}
    </div>
  );
}

// ── Centered error / loading screen ──────────────────────────────────────────
function CenteredMessage({ children }) {
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-stone-50 p-4 text-center gap-2">
      {children}
    </div>
  );
}

// ── App root ──────────────────────────────────────────────────────────────────
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

// ── EmployeeFlow — stepper 3 langkah (Nama → Selfie → Lokasi) ────────────────
function EmployeeFlow({ employees }) {
  const [step, setStep] = useState(1);
  const [absenType, setAbsenType] = useState('masuk');

  // Step 1
  const [employee, setEmployee] = useState(null);
  const [todayStatus, setTodayStatus] = useState(null); // { hasMasuk, hasKeluar, lastType }
  const [checkingStatus, setCheckingStatus] = useState(false);

  // Step 2
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const fileInputRef = useRef(null);

  // Step 3
  const [gpsStatus, setGpsStatus] = useState('idle'); // idle | checking | near | far | denied
  const [distance, setDistance] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState(null); // { type, time, flagged }

  // Gate "Absen Pulang" — dikunci sampai Stock List checklist selesai diisi.
  const [stockGate, setStockGate] = useState({ gateOpen: true, hasItems: false, complete: false });

  // --- Step 1: pilih nama ---
  const handlePickEmployee = async (emp) => {
    setEmployee(emp);
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
      if (!lastType) {
        setAbsenType('masuk');
      } else if (lastType === 'bolong') {
        setAbsenType('masuk_lagi');
      } else if (lastType === 'masuk' || lastType === 'masuk_lagi') {
        setAbsenType(stockGate.gateOpen ? 'keluar' : 'bolong');
      }
    } catch (error) {
      console.error('Gagal memuat status:', error);
      setSubmitError('Gagal mengecek riwayat absen.');
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
      if (absenType === 'masuk' && (lastType === 'masuk' || lastType === 'masuk_lagi')) {
        setSubmitError('Kamu sudah absen masuk dan masih bekerja.');
        return;
      }
      if (absenType === 'masuk' && lastType === 'keluar') {
        setSubmitError('Kamu sudah selesai kerja hari ini.');
        return;
      }
      if (absenType === 'bolong') {
        if (lastType !== 'masuk' && lastType !== 'masuk_lagi') {
          setSubmitError(
            !lastType ? 'Belum absen masuk, tidak bisa ijin bolong.' :
              lastType === 'bolong' ? 'Masih dalam jam bolong, absen masuk lagi dulu.' :
                'Tidak bisa ijin bolong setelah absen keluar.'
          );
          return;
        }
      }
      if (absenType === 'masuk_lagi') {
        if (lastType !== 'bolong') {
          setSubmitError('Hanya bisa absen masuk lagi jika status sebelumnya sedang jam bolong.');
          return;
        }
      }
      if (absenType === 'keluar') {
        if (!hasMasuk) {
          setSubmitError('Belum absen masuk, jadi belum bisa absen keluar.');
          return;
        }
        if (lastType === 'bolong') {
          setSubmitError('Peringatan: Kamu harus absen MASUK LAGI terlebih dahulu setelah jam bolong sebelum bisa pulang.');
          return;
        }
        if (hasKeluar) {
          setSubmitError('Kamu sudah absen keluar hari ini.');
          return;
        }
        if (!stockGate.gateOpen) {
          setSubmitError('Stock List belum selesai diisi. Lengkapi checklist stock dulu sebelum absen pulang.');
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
    setTodayStatus(null);
    setAbsenType('masuk');
    setPhotoFile(null);
    setPhotoPreview(null);
    setGpsStatus('idle');
    setDistance(null);
    setDone(null);
    setSubmitError('');
  };

  // ── Layar sukses ─────────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="min-h-screen bg-stone-50 py-6 px-4">
        <div className="max-w-sm mx-auto">
          <div className="bg-white rounded-3xl shadow-xl p-8 text-center">
            <div
              className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${
                done.type === 'bolong' ? 'bg-amber-100' : done.flagged ? 'bg-amber-100' : 'bg-green-100'
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

          {/* Ketentuan Kerja */}
          <WorkRulesCard />
        </div>
      </div>
    );
  }

  // ── Layar form ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-stone-50 py-4 px-4 flex flex-col items-center">
      <div className="max-w-sm w-full">

        {/* Header — dark ticket dengan jam live */}
        <div className="bg-stone-900 rounded-t-3xl px-5 pt-5 pb-4">
          <div className="flex items-center justify-center gap-2 mb-0.5">
            <Flame className="w-5 h-5 text-orange-500" />
            <span className="font-bold text-lg text-white">
              Mamam <span className="text-orange-500">Ayam</span>
            </span>
          </div>
          <p className="text-stone-500 text-xs text-center">Sistem Absen Digital</p>
          <LiveClock />
        </div>

        {/* Garis robek tiket */}
        <div className="relative h-0">
          <div className="absolute left-0 right-0 top-0 border-t-2 border-dashed border-stone-300" />
          <div className="absolute left-4 top-0 -translate-y-1/2 w-3 h-3 rounded-full bg-stone-50" />
          <div className="absolute right-4 top-0 -translate-y-1/2 w-3 h-3 rounded-full bg-stone-50" />
        </div>

        {/* Body form */}
        <div className="bg-white rounded-b-3xl shadow-xl p-5 pt-6">

          {/* Pilihan tipe absen — dinamis sesuai status karyawan */}
          {(todayStatus?.lastType === 'masuk' || todayStatus?.lastType === 'masuk_lagi') && !sudahLengkapHariIni && (
            <>
              <div className="flex bg-stone-100 rounded-xl p-1 mb-2">
                <button
                  onClick={() => setAbsenType('bolong')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition ${
                    absenType === 'bolong' ? 'bg-white shadow text-amber-700' : 'text-stone-500'
                  }`}
                >
                  <Coffee className="w-4 h-4" /> Jam Bolong
                </button>
                <button
                  onClick={() => stockGate.gateOpen && setAbsenType('keluar')}
                  disabled={!stockGate.gateOpen}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition ${
                    !stockGate.gateOpen
                      ? 'text-stone-300 cursor-not-allowed'
                      : absenType === 'keluar'
                      ? 'bg-white shadow text-orange-700'
                      : 'text-stone-500'
                  }`}
                >
                  <LogOut className="w-4 h-4" /> Pulang
                </button>
              </div>
              {!stockGate.gateOpen && (
                <p className="text-[11px] text-amber-600 text-center mb-3">
                  Absen pulang terkunci — isi Stock List di bawah dulu.
                </p>
              )}
            </>
          )}

          {todayStatus?.lastType === 'bolong' && !sudahLengkapHariIni && (
            <div className="flex flex-col gap-3 mb-5">
              <div className="flex items-center gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-3">
                <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0" />
                <p className="text-xs text-amber-700 font-medium leading-relaxed">
                  Peringatan: Kamu sedang dalam <span className="font-bold">jam bolong</span>. Segera absen <b>Masuk Lagi</b> untuk melanjutkan perhitungan jam kerja.
                </p>
              </div>
              <button
                onClick={() => setAbsenType('masuk_lagi')}
                className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition ${
                  absenType === 'masuk_lagi' ? 'bg-green-600 text-white shadow' : 'bg-green-100 text-green-700'
                }`}
              >
                <CheckCircle2 className="w-5 h-5" /> Absen Masuk Lagi
              </button>
            </div>
          )}

          {/* Stock List — hanya tampil setelah ada yang absen masuk hari ini */}
          {todayStatus?.hasMasuk && !sudahLengkapHariIni && (
            <StockChecklistCard onGateStatusChange={setStockGate} currentEmployeeName={employee?.name} />
          )}

          {/* Progress steps */}
          <div className="flex items-center justify-center mb-6">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const active = step === s.id;
              const completed = step > s.id;
              return (
                <Fragment key={s.id}>
                  <div
                    className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center transition ${
                      completed
                        ? 'bg-green-500 text-white'
                        : active
                        ? 'bg-orange-600 text-white'
                        : 'bg-stone-100 text-stone-400'
                    }`}
                  >
                    {completed ? <CheckCircle2 className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                  </div>
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

              <select
                value={employee?.id || ''}
                onChange={(e) => {
                  const selectedEmp = employees.find((emp) => emp.id === e.target.value);
                  if (selectedEmp) handlePickEmployee(selectedEmp);
                }}
                className="w-full border border-stone-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
              >
                <option value="" disabled>-- Pilih Nama --</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
              </select>

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
                  <><RotateCcw className="w-4 h-4" /> Ambil Ulang</>
                ) : (
                  <><Camera className="w-4 h-4" /> Ambil Foto</>
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
                className={`rounded-2xl p-5 flex flex-col items-center text-center gap-2 ${
                  gpsStatus === 'checking' || gpsStatus === 'idle'
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
                  <><ShieldCheck className="w-4 h-4" /> Catat Absen</>
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

        {/* Ketentuan Kerja — di bawah form card */}
        <WorkRulesCard />

      </div>
    </div>
  );
}