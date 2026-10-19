// LAN file server for PPSSPP Web.
//
//   node Web/server.js            # serve from the repo root, port 8000
//   PORT=8080 node Web/server.js
//   PPSSPP_GAMES_DIR=/path/to/isos node Web/server.js
//
// Routes:
//   /                    -> Web/index.html and other files in Web/
//   /ppsspp.js/.wasm/.data -> the build output in build-web/
//   /games/*             -> game files (default: ./games next to the repo root)
//   /games/manifest.json -> JSON listing of the games directory
//
// Sends the COOP/COEP headers the pthreads build needs for SharedArrayBuffer, and
// supports Range requests so browsers can stream big ISOs later.

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;                       // .../Web
const BUILD_DIR = path.join(ROOT, '..', process.env.PPSSPP_BUILD_DIR || 'build-web');
const BUILD_ST_DIR = path.join(ROOT, '..', process.env.PPSSPP_BUILD_ST_DIR || 'build-web-st');
const GAMES_DIR = process.env.PPSSPP_GAMES_DIR || path.join(ROOT, '..', 'games');
const PORT = Number(process.env.PORT || 8000);
// HTTPS is on by default: the pthread build needs SharedArrayBuffer, which
// browsers only expose in a secure context. Plain http on a LAN IP is not one,
// so the HTTPS URL is the one to open from other devices (accept the
// self-signed certificate warning once). Set PPSSPP_HTTPS=0 to serve http only.
const HTTPS = process.env.PPSSPP_HTTPS !== '0';
const CERT_DIR = path.join(ROOT, '..', '.certs');
const HTTPS_PORT = Number(process.env.PPSSPP_HTTPS_PORT || 8443);

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.data': 'application/octet-stream',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.iso': 'application/octet-stream',
	'.cso': 'application/octet-stream',
	'.chd': 'application/octet-stream',
	'.pbp': 'application/octet-stream',
	'.elf': 'application/octet-stream',
};

const GAME_EXTENSIONS = new Set(['.iso', '.cso', '.chd', '.pbp', '.elf']);

const COOP_COEP = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	// The emulator tab never talks to third-party origins, so allow the page to
	// work even when opened from a plain LAN hostname.
	'Cross-Origin-Resource-Policy': 'same-origin',
};

function sendError(res, code, msg) {
	res.writeHead(code, { 'Content-Type': 'text/plain', ...COOP_COEP });
	res.end(msg);
}

function serveFile(req, res, filePath) {
	fs.stat(filePath, (err, st) => {
		if (err || !st.isFile()) return sendError(res, 404, 'Not found');
		const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
		const range = req.headers.range;
		const headers = {
			'Content-Type': mime,
			'Accept-Ranges': 'bytes',
			'Cache-Control': 'no-cache',
			...COOP_COEP,
		};
		if (range) {
			const m = /bytes=(\d*)-(\d*)/.exec(range);
			let start = m && m[1] ? parseInt(m[1], 10) : 0;
			let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
			if (isNaN(start) || start < 0) start = 0;
			if (isNaN(end) || end >= st.size) end = st.size - 1;
			if (start > end) {
				res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, ...COOP_COEP });
				return res.end();
			}
			headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
			headers['Content-Length'] = end - start + 1;
			res.writeHead(206, headers);
			fs.createReadStream(filePath, { start, end }).pipe(res);
		} else {
			headers['Content-Length'] = st.size;
			res.writeHead(200, headers);
			fs.createReadStream(filePath).pipe(res);
		}
	});
}

function listGames() {
	return new Promise((resolve) => {
		fs.readdir(GAMES_DIR, { withFileTypes: true }, (err, entries) => {
			if (err) return resolve({ games: [] });
			let pending = entries.length;
			const games = [];
			if (!pending) return resolve({ games });
			for (const ent of entries) {
				const full = path.join(GAMES_DIR, ent.name);
				fs.stat(full, (e, st) => {
					if (!e && st.isFile() && GAME_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) {
						games.push({ name: ent.name, url: 'games/' + encodeURIComponent(ent.name), size: st.size });
					}
					if (--pending === 0) {
						games.sort((a, b) => a.name.localeCompare(b.name));
						resolve({ games });
					}
				});
			}
		});
	});
}

function lanAddresses() {
	const result = [];
	const ifaces = os.networkInterfaces();
	for (const name of Object.keys(ifaces)) {
		for (const iface of ifaces[name]) {
			if (iface.family === 'IPv4' && !iface.internal) result.push(iface.address);
		}
	}
	return result;
}

function selfSignedCert() {
	const key = path.join(CERT_DIR, 'key.pem');
	const crt = path.join(CERT_DIR, 'cert.pem');
	if (fs.existsSync(key) && fs.existsSync(crt)) return { key, crt };
	fs.mkdirSync(CERT_DIR, { recursive: true });
	console.log('Generating a self-signed certificate with openssl...');
	const args = [
		'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
		'-keyout', key, '-out', crt, '-days', '825',
		'-subj', '/CN=ppsspp-web',
	];
	const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map((ip) => `IP:${ip}`)].join(',');
	try {
		execFileSync('openssl', [...args, '-addext', `subjectAltName=${san}`]);
	} catch (e) {
		// Older openssl without -addext. The certificate still works, browsers
		// just show the hostname mismatch warning.
		for (const file of [key, crt]) {
			try { fs.unlinkSync(file); } catch {}
		}
		execFileSync('openssl', args);
	}
	return { key, crt };
}

const handler = async (req, res) => {
	const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

	if (urlPath === '/games/manifest.json') {
		const manifest = await listGames();
		res.writeHead(200, { 'Content-Type': MIME['.json'], ...COOP_COEP });
		return res.end(JSON.stringify(manifest));
	}

	if (urlPath.startsWith('/games/')) {
		const name = path.basename(urlPath);
		return serveFile(req, res, path.join(GAMES_DIR, name));
	}

	// Emulator build artifacts live outside Web/. The -st files are the
	// single-threaded fallback build.
	if (urlPath.startsWith('/ppsspp.')) {
		const base = path.basename(urlPath);
		return serveFile(req, res, path.join(BUILD_DIR, base));
	}
	if (urlPath.startsWith('/ppsspp-st.')) {
		const base = path.basename(urlPath);
		return serveFile(req, res, path.join(BUILD_ST_DIR, base.replace('-st', '')));
	}

	// Static files from Web/, with / mapped to index.html.
	const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
	const target = path.normalize(path.join(ROOT, rel));
	if (!target.startsWith(ROOT)) return sendError(res, 403, 'Forbidden');
	serveFile(req, res, target);
};

const server = http.createServer(handler);
server.listen(PORT, '0.0.0.0', () => printUrls('http', PORT));

if (HTTPS) {
	try {
		const { key, crt } = selfSignedCert();
		const httpsServer = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, handler);
		httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => printUrls('https', HTTPS_PORT));
	} catch (e) {
		console.log('HTTPS disabled:', e.message);
	}
}

function printUrls(scheme, port) {
	console.log(`${scheme.toUpperCase()} server listening - perangkat lain di jaringan yang sama bisa membuka:`);
	console.log(`  Local: ${scheme}://localhost:${port}/`);
	for (const address of lanAddresses()) {
		console.log(`  LAN:   ${scheme}://${address}:${port}/`);
	}
	if (scheme === 'http' && HTTPS) {
		console.log('  (Untuk main game di perangkat lain, buka URL HTTPS - SharedArrayBuffer butuh secure context.)');
	}
	console.log(`  Games: ${GAMES_DIR}`);
	console.log(`  Build: ${BUILD_DIR}` + (fs.existsSync(path.join(BUILD_ST_DIR, 'ppsspp.js')) ? ` (+ ${BUILD_ST_DIR})` : ' (single-threaded build not found - run Web/build.sh)'));
	if (!fs.existsSync(path.join(BUILD_DIR, 'ppsspp.js'))) {
		console.log('  NOTE: build output not found yet - run Web/build.sh first.');
	}
}
