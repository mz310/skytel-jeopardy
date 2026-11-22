#!/usr/bin/env node
/**
 * Build tool for the password-protected Skytel Jeopardy site. No dependencies (Node 20+).
 *
 *   node tools/site.mjs sync --repo . "canvasPath=localFile" ...
 *       Rebuild the site from files exported from the Claude canvas. The game page and the
 *       logo images are encrypted into index.html; no password is needed for this step.
 *       Prints "CHANGED: ..." or "NO CHANGES".
 *
 *   SITE_USER=... SITE_PASSWORD=... node tools/site.mjs init --repo .
 *       Create (or replace) the login. Writes tools/site-key.json. Run `sync` afterwards.
 *
 *   SITE_USER=... SITE_PASSWORD=... node tools/site.mjs check --repo .
 *       Confirm that index.html opens with this login. Prints no page content.
 *
 * How it works: `init` makes an RSA key pair. The private key is stored encrypted with a key
 * derived from "username + password" (PBKDF2); the public key is stored as is. `sync` encrypts
 * the page with a fresh AES key and wraps that key with the public key. The browser derives the
 * same key from the typed login, unlocks the private key, then the page. Nothing in this repo
 * or on the site is enough to read the page without the login.
 *
 * Exit codes: 0 ok, 2 input problem (nothing written).
 */
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const subtle = webcrypto.subtle;
const PAGE = 'project/Skytel Jeopardy v2.dc.html';
const STATE = 'project/.image-slots.state.json';
const COPIED = { 'project/support.js': 'support.js', 'project/image-slot.js': 'image-slot.js' };
const UPLOADS_PREFIX = 'project/uploads/';
const SUPPORT_TAG = '<script src="./support.js"></script>';
const HEAD_EXTRA =
  '<title>Skytel Jeopardy</title>\n' +
  '<link rel="icon" href="uploads/skytel-colored.png">\n' +
  '<script src="./vendor/react.production.min.js"></script>\n' +
  '<script src="./vendor/react-dom.production.min.js"></script>\n';
const KEY_FILE = 'tools/site-key.json';
const ITERATIONS = 600000;
const MIN_PASSWORD = 8;

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(2);
}
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const utf8 = (s) => new TextEncoder().encode(s);
const hex = (buf) => Buffer.from(buf).toString('hex');
const sha256hex = async (bytes) => hex(await subtle.digest('SHA-256', bytes));

function parseArgs(argv) {
  const out = { repo: null, pairs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') out.repo = argv[++i];
    else out.pairs.push(argv[i]);
  }
  if (!out.repo) fail('--repo is required');
  out.repo = path.resolve(out.repo);
  return out;
}

function credentials() {
  const user = (process.env.SITE_USER || '').trim().toLowerCase();
  const password = process.env.SITE_PASSWORD || '';
  if (!user) fail('set SITE_USER');
  if (password.length < MIN_PASSWORD) fail('SITE_PASSWORD must be at least ' + MIN_PASSWORD + ' characters');
  return { user, password };
}

async function deriveKek(user, password, kdf) {
  const material = await subtle.importKey('raw', utf8(user + '\n' + password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(kdf.salt), iterations: kdf.iterations }, material, 256);
  return subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function readKey(repo) {
  const file = path.join(repo, KEY_FILE);
  if (!fs.existsSync(file)) fail(KEY_FILE + ' not found: run `init` first');
  let key;
  try { key = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(KEY_FILE + ' is not valid JSON'); }
  for (const f of ['kid', 'pub', 'kdf', 'priv']) if (!key[f]) fail(KEY_FILE + ' is missing "' + f + '"');
  return key;
}

function readPayload(repo) {
  const file = path.join(repo, 'index.html');
  if (!fs.existsSync(file)) return null;
  const m = /<script id="site-payload" type="application\/json">([\s\S]*?)<\/script>/.exec(fs.readFileSync(file, 'utf8'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ---- init -----------------------------------------------------------------------------------
async function init(args) {
  const { user, password } = credentials();
  const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64(webcrypto.getRandomValues(new Uint8Array(16))) };
  const kek = await deriveKek(user, password, kdf);
  const pair = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);
  const spki = await subtle.exportKey('spki', pair.publicKey);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, kek, pkcs8);
  const key = {
    v: 1,
    kid: (await sha256hex(spki)).slice(0, 16),
    kdf,
    priv: { iv: b64(iv), ct: b64(ct) },
    pub: b64(spki),
  };
  fs.mkdirSync(path.join(args.repo, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(args.repo, KEY_FILE), JSON.stringify(key, null, 2) + '\n');
  console.log('login created, key id ' + key.kid + '. Now run `sync` to re-encrypt the site.');
}

// ---- sync -----------------------------------------------------------------------------------
function buildPlainPage(pageBytes, stateBytes) {
  const page = Buffer.from(pageBytes).toString('utf8');
  if (!page.includes('<x-dc>') || !page.includes('data-dc-script')) fail('page does not look like the Jeopardy canvas page');
  if (page.split(SUPPORT_TAG).length !== 2) fail('expected exactly one support.js script tag in the page');
  if (page.includes('vendor/react.production.min.js')) fail('page already contains the vendor React tags; expected the raw canvas page');
  let state;
  try { state = JSON.parse(Buffer.from(stateBytes).toString('utf8')); } catch { fail('.image-slots.state.json is not valid JSON'); }
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('.image-slots.state.json is not a JSON object');
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const json = JSON.stringify(state).split('<').join('\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
  // The page's image component fetches ".image-slots.state.json". Answer that fetch from the
  // copy embedded here, so the logo images travel inside the encrypted page.
  const stateScript =
    '<script>(function(){var S=' + json + ';var f=window.fetch;window.fetch=function(u){' +
    'try{var s=typeof u==="string"?u:(u&&u.url)||"";' +
    'if(/(^|\\/)\\.image-slots\\.state\\.json([?#]|$)/.test(s)){' +
    'return Promise.resolve(new Response(JSON.stringify(S),{status:200,headers:{"Content-Type":"application/json"}}));}}catch(e){}' +
    'return f.apply(this,arguments);};})();</script>\n';
  const slots = Object.keys(state).filter((k) => state[k] && typeof state[k] === 'object' && state[k].u).sort();
  return { html: page.replace(SUPPORT_TAG, HEAD_EXTRA + stateScript + SUPPORT_TAG), page, slots };
}

async function encryptPage(html, key) {
  const pub = await subtle.importKey('spki', unb64(key.pub), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const rawCk = webcrypto.getRandomValues(new Uint8Array(32));
  const ck = await subtle.importKey('raw', rawCk, 'AES-GCM', false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, ck, utf8(html));
  const wk = await subtle.encrypt({ name: 'RSA-OAEP' }, pub, rawCk);
  return { wk: b64(wk), iv: b64(iv), ct: b64(ct) };
}

async function sync(args) {
  const src = {};
  for (const pair of args.pairs) {
    const i = pair.indexOf('=');
    if (i < 1) fail('bad argument (need canvasPath=localFile): ' + pair);
    const k = pair.slice(0, i), file = pair.slice(i + 1);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail('local file not found for ' + k + ': ' + file);
    src[k] = file;
  }
  const required = [PAGE, STATE, ...Object.keys(COPIED)];
  const missing = required.filter((k) => !src[k]);
  if (missing.length) fail('missing required files: ' + missing.join(', '));

  const key = readKey(args.repo);
  const plain = buildPlainPage(fs.readFileSync(src[PAGE]), fs.readFileSync(src[STATE]));
  const out = {};
  for (const [k, dest] of Object.entries(COPIED)) out[dest] = fs.readFileSync(src[k]);
  for (const [k, file] of Object.entries(src)) {
    if (k.startsWith(UPLOADS_PREFIX)) {
      const name = k.slice(UPLOADS_PREFIX.length);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) fail('unsafe upload file name: ' + name);
      out['uploads/' + name] = fs.readFileSync(file);
    } else if (!required.includes(k)) fail('unexpected canvas path: ' + k);
  }
  const needed = [...new Set(plain.page.match(/uploads\/[A-Za-z0-9._-]+/g) || [])].sort();
  for (const rel of needed) {
    if (!out[rel] && !fs.existsSync(path.join(args.repo, rel))) fail('page uses ' + rel + ' but it was not supplied and is not in the repo');
  }
  for (const rel of ['vendor/react.production.min.js', 'vendor/react-dom.production.min.js', 'tools/login.html']) {
    if (!fs.existsSync(path.join(args.repo, rel))) fail('repo is missing ' + rel);
  }

  const shell = fs.readFileSync(path.join(args.repo, 'tools/login.html'), 'utf8');
  if (shell.split('__PAYLOAD__').length !== 2) fail('tools/login.html must contain __PAYLOAD__ exactly once');
  const digest = await sha256hex(utf8(plain.html));
  const shellDigest = await sha256hex(utf8(shell));
  const current = readPayload(args.repo);
  const sameIndex = current && current.digest === digest && current.kid === key.kid && current.shell === shellDigest;
  if (!sameIndex) {
    const enc = await encryptPage(plain.html, key);
    const payload = { v: 1, kid: key.kid, kdf: key.kdf, priv: key.priv, ...enc, digest, shell: shellDigest };
    out['index.html'] = Buffer.from(shell.replace('__PAYLOAD__', () => JSON.stringify(payload).replace(/</g, '\\u003c')), 'utf8');
  }

  const changed = [];
  for (const rel of Object.keys(out).sort()) {
    const dest = path.join(args.repo, rel);
    const old = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    if (!old || !old.equals(out[rel])) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, out[rel]);
      changed.push(rel);
    }
  }
  const stale = path.join(args.repo, '.image-slots.state.json');
  if (fs.existsSync(stale)) { fs.unlinkSync(stale); changed.push('.image-slots.state.json (removed: now inside the encrypted page)'); }

  console.log('filled image slots: ' + (plain.slots.join(', ') || 'none'));
  console.log('uploads used by page: ' + (needed.map((n) => n.slice(8)).join(', ') || 'none'));
  console.log(changed.length ? 'CHANGED: ' + changed.join(', ') : 'NO CHANGES');
}

// ---- check ----------------------------------------------------------------------------------
async function check(args) {
  const { user, password } = credentials();
  const p = readPayload(args.repo);
  if (!p) fail('index.html has no encrypted payload');
  try {
    const kek = await deriveKek(user, password, p.kdf);
    const pkcs8 = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(p.priv.iv) }, kek, unb64(p.priv.ct));
    const priv = await subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const rawCk = await subtle.decrypt({ name: 'RSA-OAEP' }, priv, unb64(p.wk));
    const ck = await subtle.importKey('raw', rawCk, 'AES-GCM', false, ['decrypt']);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(p.iv) }, ck, unb64(p.ct));
    const ok = (await sha256hex(new Uint8Array(pt))) === p.digest;
    console.log(ok ? 'OK: index.html opens with this login (' + pt.byteLength + ' bytes)' : 'FAILED: decrypted, but the content digest does not match');
    process.exit(ok ? 0 : 1);
  } catch {
    console.log('FAILED: this login does not open index.html');
    process.exit(1);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { init, sync, check };
if (!commands[cmd]) fail('usage: site.mjs <init|sync|check> --repo DIR [canvasPath=localFile ...]');
await commands[cmd](parseArgs(rest));
