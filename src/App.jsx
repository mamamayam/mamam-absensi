import { useState, useEffect, useRef } from 'react';
import {
  User, KeyRound, Camera, MapPin, CheckCircle2, AlertTriangle,
  ChevronLeft, ChevronRight, Loader2, RotateCcw, Flame,
  LogIn, LogOut, ShieldCheck, Search, Lock, Coffee,
} from 'lucide-react';
import { supabase, isConfigured } from './supabase.js';
import { getTodayStr, formatTime, generateId, distanceMeters, compressImage } from './utils.js';

// TODO: ganti 3 angka ini dengan koordinat outlet ASLI kamu.
// Caranya: buka Google Maps, klik kanan tepat di lokasi outlet, klik angka
// koordinat yang muncul di menu (otomatis ter-copy), tempel di sini.
// Placeholder sekarang masih koordinat Kemang, Jakarta Selatan (cuma contoh).
const OUTLET_LAT = Number(import.meta.env.VITE_OUTLET_LAT) || -6.2607;
const OUTLET_LNG = Number(import.meta.env.VITE_OUTLET_LNG) || 106.8133;
const OUTLET_RADIUS_M = Number(import.meta.env.VITE_OUTLET_RADIUS_M) || 100;

const OTP_GRACE_MS = 5000; // toleransi delay network/jam device pas cek expired
const PHOTO_BUCKET = 'attendance-photos';

const STEPS = [
  { id: 1, label: 'Nama', icon: User },
  { id: 2, label: 'PIN', icon: Lock },      // Step baru: verifikasi PIN karyawan
  { id: 3, label: 'OTP', icon: KeyRound },
  { id: 4, label: 'Selfie', icon: Camera },
  { id: 5, label: 'Lokasi', icon: MapPin },
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
 * EmployeeFlow — stepper 4 langkah (Nama → OTP → Selfie → Lokasi), berbasis
 * desain mockup asli. Bedanya dari mockup: semua tahap nyambung ke data asli
 * (Supabase), bukan simulasi.
 */
function EmployeeFlow({ employees }) {
  const [step, setStep] = useState(1);
  const [absenType, setAbsenType] = useState('masuk');

  // Step 1 — pilih nama
  const [search, setSearch] = useState('');
  const [employee, setEmployee] = useState(null);
  const [todayStatus, setTodayStatus] = useState(null); // { hasMasuk, hasKeluar }
  const [checkingStatus, setCheckingStatus] = useState(false);

  // Step 2 — PIN karyawan (verifikasi identitas sebelum lanjut ke OTP)
  const [pin, setPin] = useState(['', '', '', '']);
  const [pinVerified, setPinVerified] = useState(false);
  const [pinError, setPinError] = useState('');
  const pinRefs = useRef([]);

  // Step 3 — OTP
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpChecking, setOtpChecking] = useState(false);
  const [otpError, setOtpError] = useState('');
  const otpRefs = useRef([]);

  // Step 3 — selfie
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const fileInputRef = useRef(null);

  // Step 4 — GPS
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

      // Default tipe absen berdasarkan state terakhir:
      // belum ada / setelah bolong → masuk; sedang masuk → keluar (bisa ganti ke bolong via tab)
      if (!lastType || lastType === 'bolong') setAbsenType('masuk');
      else if (lastType === 'masuk') setAbsenType('keluar');
      // lastType === 'keluar' → sudahLengkapHariIni handles it
    } finally {
      setCheckingStatus(false);
    }
  };

  // --- Step 2: PIN karyawan ---
  const handlePinChange = (idx, val) => {
    if (!/^[0-9]?$/.test(val)) return;
    const next = [...pin];
    next[idx] = val;
    setPin(next);
    setPinVerified(false);
    setPinError('');
    if (val && idx < 3) pinRefs.current[idx + 1]?.focus();
  };

  const handlePinKeyDown = (idx, e) => {
    if (e.key === 'Backspace' && !pin[idx] && idx > 0) pinRefs.current[idx - 1]?.focus();
  };

  const verifyPin = () => {
    const entered = pin.join('');
    if (!employee?.pin) {
      setPinError('PIN belum diatur untuk akun ini. Hubungi admin toko.');
      return;
    }
    if (entered !== String(employee.pin)) {
      setPinError('PIN salah. Coba lagi.');
      setPin(['', '', '', '']);
      setTimeout(() => pinRefs.current[0]?.focus(), 50);
      return;
    }
    setPinVerified(true);
    setStep(3); // lanjut ke OTP
  };

  // Auto-verifikasi PIN begitu 4 digit lengkap
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (step === 2 && pin.every((d) => d !== '') && !pinVerified) {
      verifyPin();
    }
  }, [pin, step]);

  // --- Step 3: OTP ---
  // Validasi OTP LANGSUNG di sini, begitu 6 digit lengkap — JANGAN ditunda
  // sampai submit di step 4. Kalau ditunda, kode (yang cuma valid 30 detik)
  // hampir pasti udah expired pas user kelar foto+GPS, jadinya keliatan
  // "kode salah" padahal sebenarnya gak ada masalah sama kodenya.
  const handleOtpChange = (idx, val) => {
    if (!/^[0-9]?$/.test(val)) return;
    const next = [...otp];
    next[idx] = val;
    setOtp(next);
    setOtpVerified(false);
    setOtpError('');
    if (val && idx < 5) otpRefs.current[idx + 1]?.focus();
  };
  const handleOtpKeyDown = (idx, e) => {
    if (e.key === 'Backspace' && !otp[idx] && idx > 0) otpRefs.current[idx - 1]?.focus();
  };

  const verifyOtp = async () => {
    setOtpChecking(true);
    setOtpError('');
    try {
      const { data: otpRow, error } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'attendanceOtp')
        .maybeSingle();

      if (error || !otpRow?.value) {
        setOtpError('Kode belum tersedia. Minta kasir buka layar Absensi dulu.');
        return;
      }
      const otpVal = otpRow.value;
      if (String(otpVal.code) !== otp.join('')) {
        setOtpError('Kode salah. Cek lagi kode yang tampil di layar kasir.');
        return;
      }
      if (new Date(otpVal.expiresAt).getTime() + OTP_GRACE_MS < Date.now()) {
        setOtpError('Kode sudah ganti. Lihat kode terbaru di layar kasir, lalu coba lagi.');
        return;
      }
      // Valid — begitu lolos di sini, OTP dianggap selesai diverifikasi.
      // Foto/GPS sesudah ini boleh makan waktu berapa lama pun, gak akan
      // bikin OTP "expired" lagi karena gak dicek ulang di submit.
      setOtpVerified(true);
      setStep(3);
    } catch (_) {
      setOtpError('Ada gangguan koneksi. Coba lagi.');
    } finally {
      setOtpChecking(false);
    }
  };

  // Auto-validasi OTP begitu 6 digit lengkap (step OTP sekarang step 3)
  useEffect(() => {
    if (step === 3 && otp.every((d) => d !== '') && !otpVerified && !otpChecking) {
      verifyOtp();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otp, step]);

  // --- Step 3: selfie ---
  const handlePickPhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  // --- Step 4: GPS ---
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

  useEffect(() => {
    if (step === 5 && gpsStatus === 'idle') checkGps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const sudahLengkapHariIni = todayStatus?.lastType === 'keluar';

  const canNext = {
    1: !!employee && !checkingStatus && !sudahLengkapHariIni,
    2: pinVerified,
    3: otpVerified,
    4: !!photoFile,
    5: gpsStatus === 'near' || gpsStatus === 'far',
  };

  const handleSubmit = async () => {
    // Guard defensif — seharusnya gak pernah ke-trigger lewat alur UI normal,
    // tapi jaga-jaga kalau ada cara aneh buat nyampe step 4 tanpa OTP valid.
    if (!otpVerified) {
      setSubmitError('Kode OTP belum diverifikasi.');
      setStep(3);
      return;
    }

    setSubmitting(true);
    setSubmitError('');
    try {
      // 1) Cek status hari ini (bisa berubah selama proses absen jalan)
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

      // Validasi transisi state: undefined → masuk; masuk → keluar|bolong; bolong → masuk
      if (absenType === 'masuk' && lastType === 'masuk') {
        setSubmitError('Kamu sudah absen masuk dan masih bekerja.');
        return;
      }
      if (absenType === 'masuk' && lastType === 'keluar') {
        setSubmitError('Kamu sudah selesai shift hari ini.');
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

      // 2) Upload foto (kompres dulu biar kecil) — kalau gagal, absen tetap
      // lanjut tanpa foto daripada karyawan gagal absen gara-gara upload.
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
        // diemin — foto opsional, jangan blokir absen
      }

      // 3) Simpan record absen
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
    setPin(['', '', '', '']);
    setPinVerified(false);
    setPinError('');
    setOtp(['', '', '', '', '', '']);
    setOtpVerified(false);
    setOtpChecking(false);
    setOtpError('');
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
      </div>
    );
  }

  // ── Layar form ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
      <div className="max-w-sm w-full">
        <div className="bg-stone-900 rounded-t-3xl p-5">
          <div className="flex items-center gap-2 mb-1">
            <Flame className="w-5 h-5 text-orange-500" />
            <span className="font-bold text-lg text-white">
              Mamam <span className="text-orange-500">Ayam</span>
            </span>
          </div>
          <p className="text-stone-400 text-sm">Absen Pegawai Mamam Ayam</p>
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
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition ${
                  absenType === 'bolong' ? 'bg-white shadow text-amber-700' : 'text-stone-500'
                }`}
              >
                <Coffee className="w-4 h-4" /> Jam Bolong
              </button>
              <button
                onClick={() => setAbsenType('keluar')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition ${
                  absenType === 'keluar' ? 'bg-white shadow text-orange-700' : 'text-stone-500'
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
                Kamu sedang dalam <span className="font-bold">jam bolong</span>. Absen masuk lagi untuk melanjutkan shift.
              </p>
            </div>
          )}

          <div className="flex items-center justify-between mb-6">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const active = step === s.id;
              const completed = step > s.id;
              return (
                <div key={s.id} className="flex items-center flex-1">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center transition ${
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
                    <div className={`flex-1 h-0.5 mx-1 ${completed ? 'bg-green-500' : 'bg-stone-100'}`} />
                  )}
                </div>
              );
            })}
          </div>

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
                {filteredEmployees.length === 0 && (
                  <p className="text-xs text-stone-400 text-center py-4">
                    {employees.length === 0 ? 'Belum ada data karyawan.' : 'Nama tidak ditemukan.'}
                  </p>
                )}
                {filteredEmployees.map((emp) => (
                  <button
                    key={emp.id}
                    onClick={() => handlePickEmployee(emp)}
                    className={`w-full text-left px-4 py-3 rounded-xl border text-sm font-medium transition ${
                      employee?.id === emp.id
                        ? 'border-orange-500 bg-orange-50 text-orange-700'
                        : 'border-stone-200 text-stone-700 hover:bg-stone-50'
                    }`}
                  >
                    {emp.name}
                  </button>
                ))}
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

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-stone-700 block mb-1">
                  PIN Kamu
                </label>
                <p className="text-xs text-stone-400 mb-3">
                  Masukkan 4 digit PIN yang diberikan admin toko
                </p>
                <div className="flex gap-3 justify-center">
                  {pin.map((d, i) => (
                    <input
                      key={i}
                      ref={(el) => (pinRefs.current[i] = el)}
                      value={d}
                      onChange={(e) => handlePinChange(i, e.target.value)}
                      onKeyDown={(e) => handlePinKeyDown(i, e)}
                      maxLength={1}
                      inputMode="numeric"
                      type="password"
                      className="w-12 h-14 text-center text-xl font-mono font-bold border-2 border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    />
                  ))}
                </div>
              </div>
              {pinVerified && (
                <div className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 px-3 py-2 rounded-lg">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> PIN benar.
                </div>
              )}
              {pinError && (
                <div className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {pinError}
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-stone-700 block mb-1.5">Kode OTP</label>
                <p className="text-xs text-stone-400 mb-3">Lihat kode 6 digit di HP yang standby di outlet</p>
                <div className="flex gap-2 justify-between">
                  {otp.map((d, i) => (
                    <input
                      key={i}
                      ref={(el) => (otpRefs.current[i] = el)}
                      value={d}
                      onChange={(e) => handleOtpChange(i, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(i, e)}
                      maxLength={1}
                      inputMode="numeric"
                      disabled={otpChecking}
                      className="w-10 h-12 text-center text-lg font-mono font-semibold border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-50"
                    />
                  ))}
                </div>
              </div>
              {otpChecking && (
                <div className="flex items-center gap-1.5 text-xs text-stone-400">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Memeriksa kode...
                </div>
              )}
              {otpVerified && !otpChecking && (
                <div className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 px-3 py-2 rounded-lg">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Kode benar.
                </div>
              )}
              {otpError && (
                <div className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {otpError}
                </div>
              )}
            </div>
          )}

          {step === 4 && (
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

          {step === 5 && (
            <div className="space-y-4">
              <label className="text-sm font-medium text-stone-700 block">Verifikasi Lokasi</label>
              <div
                className={`rounded-2xl p-5 flex flex-col items-center text-center gap-2 ${
                  gpsStatus === 'checking' || gpsStatus === 'idle'
                    ? 'bg-stone-50'
                    : gpsStatus === 'near'
                    ? 'bg-green-50'
                    : gpsStatus === 'far'
                    ? 'bg-amber-50'
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
                    <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center">
                      <AlertTriangle className="w-6 h-6 text-amber-600" />
                    </div>
                    <span className="text-sm font-mono font-medium text-amber-700">{distance}m dari outlet</span>
                    <span className="text-xs text-amber-600">terlalu jauh dari titik outlet</span>
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
                Absen tetap tersimpan walau lokasi jauh — hanya ditandai untuk ditinjau admin.
              </p>
            </div>
          )}

          <div className="flex gap-2 mt-6">
            {step > 1 && (
              <button
                onClick={() => setStep(step - 1)}
                className="px-4 py-3 rounded-xl border border-stone-200 text-stone-500 hover:bg-stone-50"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {step < 5 ? (
              <button
                onClick={() => {
                  if (step === 2) {
                    pinVerified ? setStep(3) : verifyPin();
                  } else if (step === 3) {
                    otpVerified ? setStep(4) : verifyOtp();
                  } else {
                    setStep(step + 1);
                  }
                }}
                disabled={
                  step === 2 ? !pin.every((d) => d !== '') :
                  step === 3 ? (!otp.every((d) => d !== '') || otpChecking) :
                  !canNext[step]
                }
                className="flex-1 bg-orange-600 disabled:bg-stone-200 disabled:text-stone-400 text-white font-medium py-3 rounded-xl flex items-center justify-center gap-1.5 transition"
              >
                {step === 3 && otpChecking ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    Lanjut <ChevronRight className="w-4 h-4" />
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!canNext[5] || submitting}
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

          {submitError && step === 5 && (
            <div className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg mt-3">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {submitError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}