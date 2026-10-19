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

function showProgress(name) {
	$('progressWrap').style.display = 'block';
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
		'--fullscreen',
	]);
	setStatus('Berjalan. Klik kanvas untuk input keyboard/gamepad; Esc untuk menu.');
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
	if (new URLSearchParams(location.search).has('boot')) {
		initRuntime()
			.then((mod) => {
				hideLauncher();
				mod.callMain(['--memstick=/memstick']);
				setStatus('Menjalankan menu PPSSPP (mode uji).');
			})
			.catch((e) => setStatus('Gagal boot: ' + e.message));
	}
});
