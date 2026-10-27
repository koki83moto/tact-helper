// 授業資料の差分ダウンロード (File System Access API)
import { getResources, TACT, TactAuthError } from './tact.js';

const TACT_HOST = new URL(TACT).host;

// ---- 保存先フォルダのハンドルを IndexedDB に保存 ----
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tact-helper', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const loadRoot = () => kv('readonly', (s) => s.get('root'));
export const saveRoot = (h) => kv('readwrite', (s) => s.put(h, 'root'));

export async function pickRoot() {
  const h = await window.showDirectoryPicker({ id: 'tact-root', mode: 'readwrite' });
  await saveRoot(h);
  return h;
}

// ユーザー操作(クリック)の中で呼ぶこと
export async function ensurePermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

// ---- Windows で使えない文字を置換 ----
export function sanitize(name) {
  let s = String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!s) s = '_';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  return s.slice(0, 180);
}

// Web リンクや HTML ページは保存しない
function isSkipped(f) {
  return f.isLink || /^text\/html/i.test(f.type || '') || /\.html?$/i.test(f.name);
}

// 全角/半角・大文字/小文字の違いを無視して既存のファイル・フォルダと照合する
const normKey = (s) => s.normalize('NFKC').toLowerCase();

const indexes = new WeakMap();
async function entryIndex(dir) {
  let idx = indexes.get(dir);
  if (!idx) {
    idx = new Map();
    for await (const [name, h] of dir.entries()) idx.set(normKey(name), h);
    indexes.set(dir, idx);
  }
  return idx;
}

async function getDir(parent, name, create) {
  const idx = await entryIndex(parent);
  const h = idx.get(normKey(name));
  if (h?.kind === 'directory') return h;
  if (!create) return null;
  if (h) throw new Error(`同名のファイルがあるためフォルダを作成できません: ${name}`);
  const d = await parent.getDirectoryHandle(name, { create: true });
  idx.set(normKey(name), d);
  return d;
}

async function existingFile(dir, name) {
  const h = (await entryIndex(dir)).get(normKey(name));
  return h?.kind === 'file' ? h.getFile() : null;
}

async function writeFile(dir, name, f) {
  const res = await fetch(f.url, { credentials: 'include' });
  if (new URL(res.url).host !== TACT_HOST) throw new TactAuthError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const source = res.body;
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await source.pipeTo(w); // 完了時に自動で close される
  } catch (e) {
    await w.abort().catch(() => {});
    await dir.removeEntry(name).catch(() => {});
    throw e;
  }
}

/**
 * 選択した講義の資料をダウンロード。既に存在するファイルはスキップ。
 * @param {FileSystemDirectoryHandle} root  保存先のルートフォルダ
 * @param {{id:string,title:string}[]} sites
 * @param {{dryRun?:boolean, log:(msg:string, cls?:string)=>void}} opts
 */
export async function downloadResources(root, sites, { dryRun = false, log }) {
  const total = { downloaded: 0, missing: 0, skipped: 0, failed: 0 };
  for (const site of sites) {
    log(`▶ ${site.title}`, 'head');
    let files;
    try {
      files = await getResources(site);
    } catch (e) {
      if (e instanceof TactAuthError) throw e;
      log(`  資料一覧の取得に失敗: ${e.message}`, 'err');
      continue;
    }
    const courseDir = await getDir(root, sanitize(site.title), !dryRun);
    const dirCache = new Map([['', courseDir]]);
    let n = 0;
    for (const f of files) {
      if (isSkipped(f)) continue;
      const dirParts = f.dirs.map(sanitize);
      const name = sanitize(f.name);
      const rel = [...dirParts, name].join('\\');
      try {
        // フォルダを辿る(必要なら作成)
        let key = '';
        let dir = courseDir;
        for (const part of dirParts) {
          key += '/' + part;
          if (!dirCache.has(key)) dirCache.set(key, dir ? await getDir(dir, part, !dryRun) : null);
          dir = dirCache.get(key);
        }
        const existing = dir && (await existingFile(dir, name));
        // 0バイトのファイルは前回の失敗とみなして取り直す
        if (existing && (existing.size > 0 || f.size === 0)) {
          total.skipped++;
          continue;
        }
        if (dryRun) {
          log(`  + ${rel}`, 'new');
          total.missing++;
          n++;
          continue;
        }
        log(`  ↓ ${rel}`, 'new');
        await writeFile(dir, name, f);
        total.downloaded++;
        n++;
      } catch (e) {
        if (e instanceof TactAuthError) throw e;
        total.failed++;
        log(`  × ${rel}: ${e.message}`, 'err');
      }
    }
    if (!n) log('  (新しい資料はありません)');
  }
  return total;
}
