// PPSSPP Web shell: pick a game from the server (or a local file), download it into
// the emulator's in-memory filesystem, then boot PPSSPP's SDL frontend with it.
// All emulation and rendering happens in this browser tab; the server only serves files.

'use strict';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const setStatus = (msg) => { statusEl.textContent = msg; };
const params = new URLSearchParams(location.search);
// ?st=1 forces the single-threaded build (menu/testing; games may not boot).
const forceST = params.has('st');

function secureContextUrl() {
	if (location.protocol !== 'http:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
		return null;
	}
	return `https://${location.hostname}:8443${location.pathname}${location.search}`;
}

function showThreadsWarning() {
	if (document.getElementById('threadsWarning')) return;
	const panel = document.createElement('div');
	panel.className = 'panel';
	panel.id = 'threadsWarning';
	const title = document.createElement('h2');
	title.textContent = 'Butuh HTTPS';
	panel.appendChild(title);
	const text = document.createElement('p');
	text.textContent = 'Browser belum mengaktifkan SharedArrayBuffer di alamat ini, jadi emulator tidak bisa memakai build multithread. Buka alamat HTTPS di bawah (terima peringatan sertifikat sekali), lalu pilih game dari sana.';
	panel.appendChild(text);
	const url = secureContextUrl();
	if (url) {
		const link = document.createElement('a');
		link.href = url;
		link.textContent = url;
		panel.appendChild(link);
	}
	$('launcher').insertBefore(panel, $('launcher').firstChild);
}

function webgl2Available() {
	try {
		const c = document.createElement('canvas');
		return !!c.getContext('webgl2');
	} catch (e) {
		return false;
	}
}

// Pin the canvas backing store to whatever size SDL picked at boot. SDL/Emscripten
// resizes the backing store on fullscreen and window resize events; on some
// Chrome/ANGLE combos that leaves the GL context presenting black afterwards.
// With a fixed backing store the context never resizes - CSS scales the display -
// so there is nothing to get wrong.
function pinCanvasBacking(canvas) {
	if (canvas.__backingPinned) return;
	const w = canvas.width || 960;
	const h = canvas.height || 544;
	try {
		Object.defineProperty(canvas, 'width', { configurable: true, get: () => w, set: () => {} });
		Object.defineProperty(canvas, 'height', { configurable: true, get: () => h, set: () => {} });
		canvas.__backingPinned = true;
		console.log(`Canvas backing store pinned at ${w}x${h}`);
	} catch (err) {
		console.warn('Could not pin canvas backing store', err);
	}
}

function showProgress(name) {	$('progressWrap').style.display = 'block';
	$('progressName').textContent = name;
	$('progressPct').textContent = '';
	$('progressBar').style.width = '0%';
}

function setProgress(received, total) {
	if (!total) return;
	const pct = Math.min(100, (received / total) * 100);
	$('progressBar').style.width = pct.toFixed(1) + '%';
	$('progressPct').textContent = `${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
}

function hideLauncher() {
	$('launcher').style.display = 'none';
	$('game').style.display = 'block';
	document.body.classList.add('playing');
}

function humanSize(bytes) {
	if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
	if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
	return (bytes / 1024).toFixed(0) + ' KB';
}

// ---------------------------------------------------------------------------
// Boot sequence

let booted = false;

async function fetchIntoMEMFS(url, fsPath, name) {
	showProgress(name);
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`Gagal mengunduh ${name}: HTTP ${resp.status}`);
	const total = Number(resp.headers.get('Content-Length') || 0);
	const reader = resp.body.getReader();
	// Write chunks straight into the in-memory filesystem. Collecting them in a
	// JS array first costs roughly three times the ISO size (chunks + copy +
	// MEMFS), which matters for 300 MB+ games on memory-constrained devices.
	const stream = FS.open(fsPath, 'w+');
	let received = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			FS.write(stream, value, 0, value.length, received);
			received += value.length;
			setProgress(received, total);
		}
	} catch (err) {
		FS.close(stream);
		try { FS.unlink(fsPath); } catch (e) {}
		throw err;
	}
	FS.close(stream);
	return fsPath;
}

async function startWithServerGame(entry) {
	if (booted) return;
	if (!threadsAvailable() && !forceST) {
		showThreadsWarning();
		return;
	}
	booted = true;
	try {
		setStatus(`Mengunduh ${entry.name}...`);
		await initRuntime();
		const fsPath = '/games/' + entry.name.replace(/[\\/]/g, '_');
		await fetchIntoMEMFS(entry.url, fsPath, entry.name);
		boot(fsPath);
	} catch (err) {
		booted = false;
		setStatus('Gagal: ' + err.message);
		console.error(err);
	}
}

async function startWithLocalFile(file) {
	if (booted) return;
	if (!threadsAvailable() && !forceST) {
		showThreadsWarning();
		return;
	}
	booted = true;
	try {
		setStatus(`Memuat ${file.name}...`);
		await initRuntime();
		showProgress(file.name);
		const data = new Uint8Array(await file.arrayBuffer());
		setProgress(data.length, data.length);
		const fsPath = '/games/' + file.name.replace(/[\\/]/g, '_');
		FS.writeFile(fsPath, data);
		boot(fsPath);
	} catch (err) {
		booted = false;
		setStatus('Gagal: ' + err.message);
		console.error(err);
	}
}

// The wasm module is instantiated lazily on first game start: instantiating pulls
// the ~20 MB asset pack, which is wasted if the user never picks a game.
// Two builds exist: the pthread build (faster, needs SharedArrayBuffer, which
// requires a secure context + COOP/COEP) and a single-threaded fallback that
// runs anywhere. Pick by capability.
function threadsAvailable() {
	return self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
}

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const s = document.createElement('script');
		s.src = src;
		s.onload = resolve;
		s.onerror = () => reject(new Error('Gagal memuat ' + src));
		document.head.appendChild(s);
	});
}

let saveSyncTimer = null;
function startSaveSync() {
	if (saveSyncTimer) return;
	const sync = () => {
		try {
			FS.syncfs(false, (err) => {
				if (err) console.warn('IDBFS sync failed', err);
			});
		} catch (e) {
			console.warn('IDBFS sync failed', e);
		}
	};
	// Saves land in MEMFS first; IDBFS only persists them on an explicit syncfs.
	saveSyncTimer = setInterval(sync, 30000);
	window.addEventListener('pagehide', sync);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') sync();
	});
}

let runtimePromise = null;
function initRuntime() {
	if (runtimePromise) return runtimePromise;
	runtimePromise = (async () => {
		setStatus('Menyiapkan emulator...');
		// ?st=1 forces the single-threaded build for testing.
		const mt = threadsAvailable() && !forceST;
		if (!mt) {
			console.log('No SharedArrayBuffer - using the single-threaded build');
			await loadScript('ppsspp-st.js');
		} else {
			await loadScript('ppsspp.js');
		}
		const prefix = mt ? 'ppsspp' : 'ppsspp-st';
		const mod = await PPSSPP({
			canvas: $('canvas'),
			locateFile: (file) => (file.startsWith('ppsspp.') ? prefix + file.slice('ppsspp'.length) : file),
		});
		window.FS = mod.FS;
		pinCanvasBacking($('canvas'));
		// Persist saves and settings in IndexedDB across reloads.
		try {
			FS.mkdirTree('/memstick');
			FS.mount(FS.filesystems.IDBFS, {}, '/memstick');
			await new Promise((resolve) => FS.syncfs(true, resolve));
			startSaveSync();
		} catch (e) {
			console.warn('IDBFS mount failed, saves will not persist', e);
			FS.mkdirTree('/memstick');
		}
		FS.mkdirTree('/games');
		window.PPSSPP_MOD = mod;
		return mod;
	})();
	return runtimePromise;
}

function boot(isoPath) {
	setStatus('Memulai PPSSPP...');
	hideLauncher();
	const mod = window.PPSSPP_MOD;
	mod.callMain([
		isoPath,
		'--memstick=/memstick',
	]);
	setStatus('Berjalan. Klik kanvas untuk input keyboard/gamepad; Esc untuk menu.');
}

async function startMenu() {
	if (booted) return;
	booted = true;
	try {
		setStatus('Membuka menu PPSSPP...');
		const mod = await initRuntime();
		hideLauncher();
		mod.callMain(['--memstick=/memstick']);
		setStatus('Menu PPSSPP. Settings → Controls → Control Mapping untuk mengatur gamepad.');
	} catch (err) {
		booted = false;
		setStatus('Gagal: ' + err.message);
		console.error(err);
	}
}

function sendEscape() {
	// SDL3's emscripten backend listens for keydown/keyup on the window.
	const init = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
	window.dispatchEvent(new KeyboardEvent('keydown', init));
	window.dispatchEvent(new KeyboardEvent('keyup', init));
}

function resizeAfterFullscreen() {
	// Fullscreen changes the canvas CSS size; let SDL/PPSSPP recalculate its
	// window/viewport from the new layout before the next frame.
	setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
	$('canvas').focus();
}

function updateFullscreenButton() {
	const btn = $('fsBtn');
	if (!btn) return;
	const active = !!document.fullscreenElement || $('game').classList.contains('pseudo-fullscreen');
	btn.textContent = active ? 'Keluar Fullscreen' : 'Fullscreen';
}

function setPseudoFullscreen(on) {
	$('game').classList.toggle('pseudo-fullscreen', on);
	updateFullscreenButton();
	resizeAfterFullscreen();
}

function toggleFullscreen() {
	const el = $('game');
	if (document.fullscreenElement) {
		if (document.exitFullscreen) {
			document.exitFullscreen().then(resizeAfterFullscreen).catch((err) => console.warn('Exit fullscreen failed', err));
		}
		return;
	}
	if (el.classList.contains('pseudo-fullscreen')) {
		setPseudoFullscreen(false);
		return;
	}
	if (el.requestFullscreen) {
		el.requestFullscreen().then(() => {
			updateFullscreenButton();
			resizeAfterFullscreen();
		}).catch((err) => {
			// Safari/iOS and embedded webviews often reject element fullscreen.
			// Fill the page instead so the game is still usable.
			console.warn('Fullscreen API failed; using page fullscreen', err);
			setPseudoFullscreen(true);
		});
	} else {
		setPseudoFullscreen(true);
	}
}

function updatePadStatus() {
	const el = $('padStatus');
	if (!el) return;
	const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
	if (pads.length) {
		el.textContent = 'Gamepad: ' + pads.map((pad) => pad.id).join(' | ');
		el.style.color = '#7ee787';
	} else {
		el.textContent = 'Gamepad: belum terdeteksi - tekan tombol pada gamepad';
		el.style.color = '';
	}
}

const SETTINGS_FORMAT = 'ppsspp-web-settings';

async function ensureRuntimeFS() {
	if (window.FS) return window.FS;
	setStatus('Menyiapkan emulator...');
	await initRuntime();
	return window.FS;
}

function readFsText(fs, path) {
	try {
		return fs.readFile(path, { encoding: 'utf8' });
	} catch (err) {
		return null;
	}
}

async function exportSettings() {
	try {
		const hadRuntime = !!window.FS;
		const fs = await ensureRuntimeFS();
		if (!hadRuntime) {
			// Loading the emulator can outlast the browser's transient user
			// activation, which makes the download silently blocked. Ask for a
			// second click now that FS is ready.
			setStatus('Emulator siap. Klik "Ekspor pengaturan" sekali lagi.');
			return;
		}
		const ppssppIni = readFsText(fs, '/memstick/PSP/SYSTEM/ppsspp.ini');
		const controlsIni = readFsText(fs, '/memstick/PSP/SYSTEM/controls.ini');
		if (!ppssppIni && !controlsIni) {
			setStatus('Belum ada file pengaturan untuk diekspor.');
			return;
		}
		const data = { format: SETTINGS_FORMAT, version: 1, ppssppIni, controlsIni };
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = 'ppsspp-web-settings.json';
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 2000);
		setStatus('Pengaturan diekspor ke ppsspp-web-settings.json.');
	} catch (err) {
		setStatus('Gagal ekspor: ' + err.message);
		console.error(err);
	}
}

function importSettings(file) {
	const reader = new FileReader();
	reader.onload = async () => {
		try {
			const data = JSON.parse(String(reader.result));
			if (data.format !== SETTINGS_FORMAT) {
				throw new Error('File bukan ekspor pengaturan PPSSPP Web');
			}
			if (data.ppssppIni != null && typeof data.ppssppIni !== 'string') throw new Error('ppssppIni tidak valid');
			if (data.controlsIni != null && typeof data.controlsIni !== 'string') throw new Error('controlsIni tidak valid');
			const fs = await ensureRuntimeFS();
			fs.mkdirTree('/memstick/PSP/SYSTEM');
			let count = 0;
			if (typeof data.ppssppIni === 'string') {
				fs.writeFile('/memstick/PSP/SYSTEM/ppsspp.ini', data.ppssppIni);
				count++;
			}
			if (typeof data.controlsIni === 'string') {
				fs.writeFile('/memstick/PSP/SYSTEM/controls.ini', data.controlsIni);
				count++;
			}
			if (!count) throw new Error('File tidak berisi pengaturan');
			await new Promise((resolve, reject) => fs.syncfs(false, (err) => (err ? reject(err) : resolve())));
			setStatus('Pengaturan diimpor. Memuat ulang halaman...');
			setTimeout(() => location.reload(), 900);
		} catch (err) {
			setStatus('Gagal impor: ' + err.message);
			console.error(err);
		}
	};
	reader.onerror = () => setStatus('Gagal membaca file.');
	reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// UI wiring

async function loadGameList() {
	const list = $('gameList');
	try {
		const resp = await fetch('games/manifest.json');
		if (!resp.ok) throw new Error('HTTP ' + resp.status);
		const manifest = await resp.json();
		if (!manifest.games.length) {
			list.innerHTML = '<li><span class="hint">Tidak ada game di server. Letakkan file .iso di folder games/ server lalu muat ulang halaman.</span></li>';
			return;
		}
		for (const game of manifest.games) {
			const li = document.createElement('li');
			const name = document.createElement('span');
			name.className = 'name';
			name.textContent = game.name;
			const size = document.createElement('span');
			size.className = 'size';
			size.textContent = humanSize(game.size);
			const btn = document.createElement('button');
			btn.textContent = 'Main';
			btn.addEventListener('click', () => startWithServerGame(game));
			li.append(name, size, btn);
			list.appendChild(li);
		}
	} catch (err) {
		list.innerHTML = '<li><span class="hint">Daftar game dari server tidak tersedia (games/manifest.json). Pilih file lokal di bawah.</span></li>';
	}
}

$('fileInput').addEventListener('change', (e) => {
	if (e.target.files.length) startWithLocalFile(e.target.files[0]);
});

window.addEventListener('DOMContentLoaded', () => {
	$('menuOnlyBtn').addEventListener('click', startMenu);
	$('exportSettingsBtn').addEventListener('click', exportSettings);
	$('importSettingsBtn').addEventListener('click', () => $('settingsInput').click());
	$('settingsInput').addEventListener('change', (e) => {
		if (e.target.files.length) importSettings(e.target.files[0]);
		e.target.value = '';
	});
	$('menuBtn').addEventListener('click', sendEscape);
	$('fsBtn').addEventListener('click', toggleFullscreen);
	$('canvas').addEventListener('click', () => $('canvas').focus());
	window.addEventListener('gamepadconnected', updatePadStatus);
	window.addEventListener('gamepaddisconnected', updatePadStatus);
	document.addEventListener('fullscreenchange', () => {
		updateFullscreenButton();
		resizeAfterFullscreen();
	});
	setInterval(updatePadStatus, 2000);
	updatePadStatus();
	updateFullscreenButton();

	if (!webgl2Available()) {
		$('webglWarn').style.display = 'block';
	}
	if (!threadsAvailable()) {
		if (forceST) {
			const hint = document.createElement('div');
			hint.className = 'hint';
			hint.style.color = '#ffb454';
			hint.textContent = 'Mode single-threaded (?st=1): menu PPSSPP jalan, tetapi game bisa hang. Untuk main game, buka URL HTTPS (build multithread).';
			$('launcher').insertBefore(hint, $('launcher').firstChild);
		} else {
			showThreadsWarning();
		}
	}
	loadGameList();
	setStatus('Pilih game untuk mulai.');
	// Smoke-test hook: /?boot=menu boots straight into PPSSPP's own menu, no game.
	if (params.has('boot')) {
		startMenu();
	}
});
