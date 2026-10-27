// TACT (Sakai) の REST API (/direct/...) へのアクセス
export const TACT = 'https://tact.ac.thers.ac.jp';
const TACT_HOST = new URL(TACT).host;

export class TactAuthError extends Error {
  constructor(msg = 'TACTにログインしていません') {
    super(msg);
    this.name = 'TactAuthError';
  }
}

async function getJSON(path) {
  const res = await fetch(TACT + path, { credentials: 'include', cache: 'no-store' });
  // 未ログイン時はシングルサインオンの画面(HTML)へリダイレクトされる
  if (new URL(res.url).host !== TACT_HOST) throw new TactAuthError();
  const type = res.headers.get('content-type') || '';
  if (res.ok && !type.includes('json')) throw new TactAuthError();
  if (!res.ok) throw new Error(`TACT ${path}: HTTP ${res.status}`);
  return res.json();
}

export function toMillis(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  if (typeof t === 'string') {
    if (/^\d+$/.test(t)) return toMillis(Number(t));
    const n = Date.parse(t);
    return Number.isNaN(n) ? null : n;
  }
  if (typeof t === 'object') {
    if (t.epochSecond != null) return t.epochSecond * 1000;
    if (t.time != null) return t.time;
  }
  return null;
}

export async function getSession() {
  const s = await getJSON('/direct/session/current.json');
  if (!s.userId) throw new TactAuthError();
  return s;
}

// 「[遠隔]」「（旧:１）」「(2026年度秋１期/木３限,…)」などを除いた講義名だけを返す
export function cleanTitle(raw) {
  const s = String(raw)
    // 全角英数字・記号・スペースを半角に統一
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/[\[［【][^\]］】]*[\]］】]/g, '')
    .replace(/[(（][^()（）]*(?:旧|年度|期|限)[^()（）]*[)）]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s || String(raw).trim();
}

export async function getSites() {
  const data = await getJSON('/direct/site.json?_limit=1000');
  return (data.site_collection || [])
    .filter((s) => !s.id.startsWith('~') && !s.id.startsWith('!'))
    .map((s) => ({ id: s.id, title: cleanTitle(s.title), rawTitle: s.title }));
}

export async function getFavoriteSiteIds() {
  try {
    const res = await fetch(TACT + '/portal/favorites/list', { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return [];
    const j = await res.json();
    return j.favoriteSiteIds || [];
  } catch {
    return [];
  }
}

function isSubmitted(a) {
  const subs = Array.isArray(a.submissions) ? a.submissions : [];
  return subs.some((s) => {
    if (!s || s.draft === true) return false;
    const dated = !!(s.dateSubmitted || s.dateSubmittedEpochSeconds || s.timeSubmitted);
    if (s.submitted === true) return s.userSubmission !== false || dated;
    if (s.submitted == null && s.userSubmission === true && dated) return true;
    return /^(提出済|Submitted)/i.test(s.status || '');
  });
}

function siteUrl(siteId) {
  return `${TACT}/portal/site/${encodeURIComponent(siteId)}`;
}

export async function getAssignments(site) {
  const data = await getJSON(`/direct/assignment/site/${encodeURIComponent(site.id)}.json`);
  const list = data.assignment_collection || [];
  const out = [];
  for (let a of list) {
    // 一覧に提出情報が含まれない場合は個別APIで取得する
    if (!Array.isArray(a.submissions)) {
      try {
        a = { ...a, ...(await getJSON(`/direct/assignment/item/${encodeURIComponent(a.id)}.json`)) };
      } catch (e) {
        if (e instanceof TactAuthError) throw e;
      }
    }
    out.push({
      key: 'a:' + a.id,
      kind: 'assignment',
      siteId: site.id,
      siteTitle: site.title,
      title: a.title,
      due: toMillis(a.dueTime) ?? toMillis(a.dueTimeString) ?? toMillis(a.dueDate),
      close: toMillis(a.closeTime) ?? toMillis(a.closeDate),
      submitted: isSubmitted(a),
      url: siteUrl(site.id),
    });
  }
  return out;
}

// 小テスト(Samigo)。APIから提出状況は取れないため、手動完了で管理する
export async function getQuizzes(site) {
  const data = await getJSON(`/direct/sam_pub/context/${encodeURIComponent(site.id)}.json`);
  return (data.sam_pub_collection || []).map((q) => ({
    key: 'q:' + q.publishedAssessmentId,
    kind: 'quiz',
    siteId: site.id,
    siteTitle: site.title,
    title: q.title,
    due: toMillis(q.dueDate),
    close: toMillis(q.retractDate),
    submitted: false,
    url: siteUrl(site.id),
  }));
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function pathOf(u) {
  try {
    return safeDecode(new URL(u).pathname);
  } catch {
    return safeDecode(u);
  }
}

// リソースを平坦なファイル一覧(フォルダ階層付き)で返す
export async function getResources(site) {
  const data = await getJSON(`/direct/content/site/${encodeURIComponent(site.id)}.json`);
  const items = data.content_collection || [];
  const rootPath = `/access/content/group/${site.id}/`;

  const folderTitles = new Map();
  for (const it of items) {
    if (it.type === 'collection') folderTitles.set(pathOf(it.url).replace(/\/?$/, '/'), it.title);
  }

  const files = [];
  for (const it of items) {
    if (it.type === 'collection') continue;
    const p = pathOf(it.url);
    const idx = p.indexOf(rootPath);
    if (idx < 0) continue;
    const rel = p.slice(idx + rootPath.length).split('/').filter(Boolean);
    if (!rel.length) continue;
    const dirs = [];
    let acc = p.slice(0, idx + rootPath.length);
    for (let i = 0; i < rel.length - 1; i++) {
      acc += rel[i] + '/';
      dirs.push(folderTitles.get(acc) || rel[i]);
    }
    files.push({
      url: it.url,
      dirs,
      name: rel[rel.length - 1] || it.title,
      title: it.title,
      type: it.type,
      size: typeof it.size === 'number' ? it.size : null,
      isLink: it.type === 'text/url',
    });
  }
  return files;
}

// 診断用: 生のJSONを取得
export async function rawJSON(path) {
  return getJSON(path);
}
