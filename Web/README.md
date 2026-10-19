# PPSSPP Web (WebAssembly)

PPSSPP yang berjalan 100% di browser: emulasi, rendering, audio, dan save game
semuanya di perangkat klien. Server hanya menyajikan file statis (build emulator
dan file game).

```
Server (LAN)                     Browser (klien)
+-----------------+   HTTP GET   +---------------------------+
| build-web/      | ------------> | ppsspp.wasm (emulasi)     |
| Web/index.html  |               | WebGL2 canvas (GPU lokal) |
| games/*.iso     | <-- fetch --  | IndexedDB (save game)     |
+-----------------+               +---------------------------+
```

## Build

Butuh [emsdk](https://emscripten.org) (6.x) dan `cmake`:

```bash
./Web/build.sh          # dua flavor:
                        # build-web/     pthread (untuk main game; butuh SAB)
                        # build-web-st/  single-threaded (fallback menu/testing)
./Web/build.sh st       # hanya flavor single-threaded
```

Flag build utama (lihat blok `if(EMSCRIPTEN)` di `CMakeLists.txt`):

- **Dua flavor** (`WEB_PTHREADS=ON/OFF`): build pthread membutuhkan
  SharedArrayBuffer, yang hanya tersedia pada secure context (https /
  localhost) plus header COOP/COEP. Build single-threaded bisa dibuka di
  http biasa, tetapi hanya cocok untuk menu/testing; boot game masih bisa
  hang karena PPSSPP membutuhkan thread loader dan IO manager.
- Backend GPU: GLES di atas WebGL2 (`-sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2`).
- CPU: IR interpreter (`SYSPROP_CAN_JIT` = false). JIT membutuhkan memori
  executable yang tidak ada di wasm.
- `USE_FFMPEG=OFF` untuk saat ini: belum ada build ffmpeg wasm, jadi pemutaran
  video cutscene tidak jalan (game tetap bisa dimainkan).
- Aset (`assets/`) dimatikan ke `ppsspp.data` lewat `--preload-file`.

## Menjalankan

```bash
mkdir -p games          # letakkan .iso/.cso/.pbp di sini
node Web/server.js      # http :8000 dan https :8443 (sertifikat self-signed)
```

Buka alamat **https** yang dicetak server
(`https://<IP-LAN>:8443/`) dari perangkat lain di jaringan yang sama, lalu
terima peringatan sertifikat sekali. SharedArrayBuffer hanya aktif di secure
context; membuka `http://<IP-LAN>:8000/` akan menampilkan peringatan dan tidak
menjalankan game. `PPSSPP_HTTPS=0 node Web/server.js` menyajikan http saja
(berguna untuk `localhost` atau mode menu `?st=1`).

Alur aplikasi: pilih game dari daftar (dari `games/manifest.json`) atau dari
file lokal -> ISO diunduh langsung ke MEMFS sambil berjalan -> emulator boot
ke game. Save game dan `ppsspp.ini` persisten lewat IDBFS (IndexedDB). Server
hanya mengirim file; emulasi, rendering, audio, dan save semuanya di klien.

## Catatan teknis

- `SDL/SDLMain.cpp` mempunyai jalur `__EMSCRIPTEN__`: browser main thread
  tetap menjadi render thread (WebGL context hanya bisa dipakai dari situ);
  tiap callback `requestAnimationFrame` memompa input SDL lalu menarik
  antrean GL hanya bila ada kerjaan (`ThreadFramePending()`, pola yang sama
  seperti frontend libretro - `ThreadFrame()` kosong memblokir memakai futex
  yang membekukan event loop browser). Emulasi berjalan di worker pthread
  lewat `EmuThread_Start`.
- `<canvas id="canvas">` wajib: driver video SDL3 Emscripten mencari kanvas
  lewat properti `SDL_PROP_WINDOW_CREATE_EMSCRIPTEN_CANVAS_ID_STRING` yang
  defaultnya `#canvas`.
- `-sPTHREAD_POOL_SIZE=16`: PPSSPP menyikan beberapa thread (emu thread,
  thread pool inti, recent files, audio SDL). Pool default 4 habis dan
  spawn thread mengantre -> deadlock.
- Build single-threaded (`-DWEB_PTHREADS=OFF`, macro `__EMSCRIPTEN_ST__`):
  - `ThreadManager` menjalankan task inline di thread pemanggil,
    `RecentFiles::EnsureThread` dan `PathBrowser` tanpa thread (list
    direktori sinkron).
  - Loader thread (`PSP_InitStart`), IO manager, dan flush thread MemBlockInfo
    dijalankan inline.
  - `GLRenderManager`: dua titik wait (fence di BeginFrame, sync) menarik
    antrean sendiri secara inline - menunggu sungguhan di main thread
    browser berarti busy-spin selamanya.
  - `Common/TimeUtil`: sleep jadi no-op; `requestAnimationFrame` memacing
    laju frame. (`emscripten_thread_sleep` hanya valid di worker; di main
    thread ia busy-spin - inilah penyebab layar beku sebelumnya.)
  - Meski begitu, boot game di flavor ini masih bisa hang; main game memakai
    build pthread. `?st=1` hanya untuk menguji menu.
- `ppsspp_config.h`: wasm tidak lagi mengklaim arsitektur X86 (dulu iya
  supaya jalur SSE terpakai), karena `<x86intrin.h>` menarik intrinsik
  MMX/eflags yang tidak bisa diterjemahkan emscripten. Kode generik saja.
- `Core/MIPS/MIPSAsm.cpp` men-stub armips (assembler debugger) di web karena
  `ghc::filesystem` milik armips tidak mendukung wasm; `SymbolMap::GetLabels`
  di-guard juga karena tipenya dari armips.
- Uji cepat tanpa game: buka `/?boot=menu` (tambah `&st=1` untuk memaksa
  build single-threaded).

### Perbaikan jalur GPU/thread web

- `GLRenderManager::ThreadFrameNonBlocking()`: callback `requestAnimationFrame`
  tidak boleh memanggil `ThreadFrame()` yang memblokir menunggu task
  berikutnya. Saat emu thread sedang di tengah boot/ISO load, main thread
  ikut membeku dan browser berhenti merespons.
- Refresh rate: driver video SDL emscripten melaporkan 0. `NativeFrame`
  membaginya untuk throttle, dan `sleep_us` dengan nilai hasil pembagian itu
  menjadi tidur sangat lama. Build web memaksa 60 Hz jika nilainya <= 0.
- GLES3: `gl3stubInit()` gagal di wasm, sehingga WebGL2 terdeteksi sebagai
  GLES2 dan FBO memakai format depth/stencil unsized yang ditolak WebGL2
  (`GL_FRAMEBUFFER_UNSUPPORTED`, layar hitam). Build web memaksa `GLES3`
  karena WebGL2 menyediakan entry point ES3 secara langsung.
- Unduhan ISO ditulis per chunk ke MEMFS (`FS.open`/`FS.write`), tidak
  dikumpulkan di array JS lalu disalin, untuk menghemat memori.

## WebGPU

PPSSPP upstream **belum punya backend WebGPU** (yang ada: GLES, Vulkan, D3D11,
Software, Null). Port web ini memakai jalur GLES -> WebGL2, dan jalur itu sudah
diverifikasi merender game (Harvest Moon: Boy & Girl) di Chrome dengan GPU
Intel. WebGL2 juga memberi akselerasi GPU lokal tanpa server tambahan.

WebGPU bukan sekadar mengganti context: ia membutuhkan backend baru
`GPU/WebGPU` yang mengimplementasikan seluruh siklus render PPSSPP (pipeline,
bind group, framebuffer, texture upload, readback) plus generator shader WGSL.
Perkiraan besarnya mengikuti backend Vulkan (sekitar 5 ribu baris untuk
backend + render manager), ditambah generator shader dan penyesuaian karena
WebGPU tidak punya geometry shader. Ini proyek terpisah dari port wasm; port
ini tidak berubah saat backend WebGPU dibuat karena semua backend duduk di
belakang abstraksi `DrawContext`/`GraphicsContext`.

Kalau WebGPU wajib, urutan yang masuk akal:

1. Backend `GPU/WebGPU` yang mengimplementasikan `DrawContext`
   (`Common/GPU/thin3d.h`): pipeline state objects, bind groups, dan
   vertex/texture upload, mengikuti bentuk `GPU/Vulkan`.
2. Konversi shader: generator GLSL yang ada perlu target WGSL (atau jalur
   GLSL -> SPIR-V -> WGSL via glslang + tint).
3. Kompilasi memakai port `--use-port=emdawnwebgpu` (Dawn `webgpu.h` di
   emsdk 6.x; `USE_WEBGPU` lama sudah tidak didukung).
