import { TACT, getSession, getSites, getFavoriteSiteIds, rawJSON, TactAuthError } from './lib/tact.js';
import { getToken, displayDue } from './lib/calendar.js';
import { loadRoot, pickRoot, ensurePermission, downloadResources } from './lib/download.js';

const $ = (id) => document.getElementById(id);
let allSites = [];
let favorites = new Set();

function setPill(el, text, cls) {
  el.className = 'pill ' + (cls || '');
  el.innerHTML = text;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---------- 接続状態 ----------
async function checkTact() {
  try {
    const s = await getSession();
    setPill($('tactState'), `TACT: ${s.userEid || s.userId}`, 'ok');
    return true;
  } catch (e) {
    setPill($('tactState'), `TACT: <a href="${TACT}/portal" target="_blank">ログインしてください</a>`, 'err');
    return false;
  }
}

async function checkGoogle(interactive) {
  try {
    await getToken(interactive);
    setPill($('googleState'), 'Google: 接続済み', 'ok');
    $('googleBtn').hidden = true;
  } catch (e) {
    setPill($('googleState'), 'Google: 未接続', 'err');
    $('googleBtn').hidden = false;
    if (interactive) alert('Googleへの接続に失敗しました: ' + e.message);
  }
}

// ---------- 講義選択 ----------
async function loadSites() {
  const box = $('sites');
  try {
    [allSites, favorites] = await Promise.all([getSites(), getFavoriteSiteIds().then((ids) => new Set(ids))]);
  } catch (e) {
    box.textContent = e instanceof TactAuthError ? 'TACTにログインしてから再読み込みしてください。' : '講義一覧の取得に失敗: ' + e.message;
    return;
  }
  const { selectedSites } = await chrome.storage.local.get('selectedSites');
  // 初回はお気に入りの講義をすべて選択。以降は講義名を最新の表記に更新
  await saveSelection(selectedSites || allSites.filter((s) => favorites.has(s.id)));
  if (!favorites.size) $('showAll').checked = true;
  renderSites();
}

async function renderSites() {
  const { selectedSites = [] } = await chrome.storage.local.get('selectedSites');
  const selected = new Set(selectedSites.map((s) => s.id));
  const showAll = $('showAll').checked;
  const list = allSites.filter((s) => showAll || favorites.has(s.id) || selected.has(s.id));
  const box = $('sites');
  box.textContent = '';
  for (const s of list) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(s.id);
    cb.addEventListener('change', async () => {
      const { selectedSites: cur = [] } = await chrome.storage.local.get('selectedSites');
      const next = cur.filter((x) => x.id !== s.id);
      if (cb.checked) next.push({ id: s.id, title: s.title });
      await saveSelection(next);
    });
    label.title = s.rawTitle;
    label.append(cb, document.createTextNode(s.title));
    box.append(label);
  }
  if (!list.length) box.textContent = '講義がありません。「お気に入り以外の講義も表示」をオンにしてください。';
}

function saveSelection(sites) {
  // 講義名の変更に追従するため最新のタイトルで保存
  const byId = new Map(allSites.map((s) => [s.id, s]));
  return chrome.storage.local.set({ selectedSites: sites.map((s) => ({ id: s.id, title: byId.get(s.id)?.title || s.title })) });
}

async function selectedSites() {
  const { selectedSites = [] } = await chrome.storage.local.get('selectedSites');
  return selectedSites;
}

// ---------- カレンダー同期 ----------
async function renderSync() {
  const { syncStatus, tasks = [], manualDone = {} } = await chrome.storage.local.get(['syncStatus', 'tasks', 'manualDone']);
  const st = $('syncStatus');
  if (syncStatus) {
    const when = new Date(syncStatus.time).toLocaleString('ja-JP');
    if (syncStatus.ok) {
      st.className = 'status';
      st.textContent = `最終同期 ${when}（追加 ${syncStatus.added} / 更新 ${syncStatus.updated} / 削除 ${syncStatus.removed}）`;
      if (syncStatus.warnings?.length) st.textContent += ' ⚠ ' + syncStatus.warnings.join(' / ');
    } else {
      st.className = 'status err';
      st.textContent = `同期エラー ${when}: ${syncStatus.error}`;
    }
  }
  const tbody = $('tasks').querySelector('tbody');
  tbody.textContent = '';
  const now = Date.now();
  for (const t of tasks) {
    const tr = document.createElement('tr');
    const done = t.submitted || !!manualDone[t.key];
    if (done) tr.className = 'done';
    else if (t.due > now && t.due < now + 3 * 864e5) tr.className = 'urgent';
    const state = t.submitted ? '提出済' : manualDone[t.key] ? '手動で完了' : t.due < now ? '締切超過' : '未提出';
    const cells = [fmtDate(displayDue(t.due)), t.siteTitle, (t.kind === 'quiz' ? '[小テスト] ' : '') + t.title, state];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    const td = document.createElement('td');
    if (!t.submitted) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!manualDone[t.key];
      cb.title = 'チェックするとカレンダーから削除します';
      cb.addEventListener('change', async () => {
        const { manualDone: md = {} } = await chrome.storage.local.get('manualDone');
        if (cb.checked) md[t.key] = true;
        else delete md[t.key];
        await chrome.storage.local.set({ manualDone: md });
        sync(false);
      });
      td.append(cb);
    }
    tr.append(td);
    tbody.append(tr);
  }
  if (!tasks.length) tbody.innerHTML = '<tr><td colspan="5">（同期すると表示されます）</td></tr>';
}

async function sync(interactive) {
  $('syncBtn').disabled = true;
  $('syncStatus').className = 'status';
  $('syncStatus').textContent = '同期中…';
  const r = await chrome.runtime.sendMessage({ type: 'sync', interactive });
  $('syncBtn').disabled = false;
  await renderSync();
  if (r.ok) checkGoogle(false);
}

// ---------- ダウンロード ----------
async function renderRoot() {
  const h = await loadRoot();
  $('rootName').textContent = h ? `選択中: ${h.name}` : '未選択';
}

const log = (msg, cls) => {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = msg + '\n';
  $('log').append(span);
  $('log').scrollTop = $('log').scrollHeight;
};

async function runDownload(dryRun) {
  const root = await loadRoot();
  if (!root) return alert('先に保存先フォルダを選択してください');
  if (!(await ensurePermission(root))) return alert('フォルダへの書き込みが許可されませんでした');
  const sites = await selectedSites();
  if (!sites.length) return alert('対象の講義を選択してください');
  for (const b of ['dryBtn', 'dlBtn', 'pickBtn']) $(b).disabled = true;
  $('log').textContent = '';
  log(`保存先: ${root.name}  ${dryRun ? '（確認のみ）' : ''}`);
  try {
    const r = await downloadResources(root, sites, { dryRun, log });
    log(dryRun ? `完了: 不足 ${r.missing} 件 / 既存 ${r.skipped} 件` : `完了: ダウンロード ${r.downloaded} 件 / 既存 ${r.skipped} 件 / 失敗 ${r.failed} 件`, 'head');
  } catch (e) {
    log(e instanceof TactAuthError ? 'TACTのログインが切れています。ログインし直してから再実行してください。' : 'エラー: ' + e.message, 'err');
  } finally {
    for (const b of ['dryBtn', 'dlBtn', 'pickBtn']) $(b).disabled = false;
  }
}

// ---------- 診断 ----------
async function diagnose() {
  const out = $('diag');
  out.textContent = '取得中…';
  const [site] = await selectedSites();
  if (!site) return (out.textContent = '講義を1つ以上選択してください');
  const id = encodeURIComponent(site.id);
  const parts = [];
  for (const [label, path] of [
    ['課題', `/direct/assignment/site/${id}.json`],
    ['小テスト', `/direct/sam_pub/context/${id}.json`],
    ['リソース', `/direct/content/site/${id}.json`],
  ]) {
    try {
      const j = await rawJSON(path);
      const key = Object.keys(j).find((k) => Array.isArray(j[k]));
      const arr = key ? j[key] : [];
      parts.push(`=== ${label} (${path}) 件数 ${arr.length}\n` + JSON.stringify(arr.slice(0, 2), null, 2));
    } catch (e) {
      parts.push(`=== ${label} (${path})\nエラー: ${e.message}`);
    }
  }
  out.textContent = `講義: ${site.title}\n\n` + parts.join('\n\n');
}

// ---------- 初期化 ----------
$('googleBtn').addEventListener('click', () => checkGoogle(true));
$('showAll').addEventListener('change', renderSites);
$('syncBtn').addEventListener('click', () => sync(true));
$('pickBtn').addEventListener('click', async () => {
  try {
    await pickRoot();
    renderRoot();
  } catch (e) {
    if (e.name !== 'AbortError') alert(e.message);
  }
});
$('dryBtn').addEventListener('click', () => runDownload(true));
$('dlBtn').addEventListener('click', () => runDownload(false));
$('diagBtn').addEventListener('click', diagnose);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.syncStatus || changes.tasks) renderSync();
});

(async () => {
  checkGoogle(false);
  renderRoot();
  renderSync();
  if (await checkTact()) loadSites();
  else $('sites').textContent = 'TACTにログインしてからこのページを再読み込みしてください。';
})();
