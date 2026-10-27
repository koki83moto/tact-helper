// TACT の課題・小テストを Google カレンダーへ同期する
import { getSession, getAssignments, getQuizzes, TactAuthError } from './tact.js';
import { Calendar, displayDue } from './calendar.js';

const DAY = 24 * 60 * 60 * 1000;
// 締切からこの期間を過ぎた未提出課題は新規には登録しない
const PAST_WINDOW = 14 * DAY;

let running = null;

export function runSync(opts = {}) {
  if (!running) running = doSync(opts).finally(() => (running = null));
  return running;
}

function eventBody(t) {
  const due = new Date(displayDue(t.due)).toISOString();
  const label = t.kind === 'quiz' ? '[小テスト] ' : '';
  const body = {
    summary: `${label}${t.title}（${t.siteTitle}）`,
    description: `TACT: ${t.url}\n\nTACT Helper が自動管理する予定です。提出が確認されると自動で削除されます。`,
    start: { dateTime: due, timeZone: 'Asia/Tokyo' },
    end: { dateTime: due, timeZone: 'Asia/Tokyo' },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 24 * 60 },
        { method: 'popup', minutes: 3 * 60 },
      ],
    },
    extendedProperties: { private: { tactKey: t.key, tactSite: t.siteId } },
  };
  if (t.kind === 'quiz') body.colorId = '5';
  return body;
}

function needsUpdate(ev, body) {
  return ev.summary !== body.summary || Date.parse(ev.start?.dateTime) !== Date.parse(body.start.dateTime);
}

async function setStatus(status) {
  await chrome.storage.local.set({ syncStatus: { time: Date.now(), ...status } });
  if (status.error) {
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: 'TACT Helper: ' + status.error });
  } else {
    const n = status.urgent || 0;
    await chrome.action.setBadgeBackgroundColor({ color: '#f29900' });
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
    await chrome.action.setTitle({ title: `TACT Helper: 3日以内の締切 ${n}件` });
  }
}

async function doSync({ interactive = false } = {}) {
  const st = await chrome.storage.local.get(['selectedSites', 'manualDone', 'calendarId']);
  const sites = st.selectedSites || [];
  const manualDone = st.manualDone || {};
  try {
    if (!sites.length) throw new Error('同期対象の講義が選択されていません');
    await getSession();

    const tasks = new Map();
    const failed = new Set(); // "a:siteId" / "q:siteId" 取得に失敗したもの(予定を消さない)
    const warnings = [];
    for (const site of sites) {
      try {
        for (const t of await getAssignments(site)) tasks.set(t.key, t);
      } catch (e) {
        if (e instanceof TactAuthError) throw e;
        failed.add('a:' + site.id);
        warnings.push(`${site.title}: 課題の取得に失敗 (${e.message})`);
      }
      try {
        for (const t of await getQuizzes(site)) tasks.set(t.key, t);
      } catch (e) {
        if (e instanceof TactAuthError) throw e;
        failed.add('q:' + site.id); // 小テストツールが無い講義もある
      }
    }

    const now = Date.now();
    const isDone = (t) => t.submitted || !!manualDone[t.key];
    const wanted = [...tasks.values()].filter((t) => t.due && !isDone(t) && t.due > now - PAST_WINDOW);

    const cal = new Calendar(interactive);
    const calendarId = await cal.ensureCalendar(st.calendarId);
    if (calendarId !== st.calendarId) await chrome.storage.local.set({ calendarId });

    const existing = new Map();
    const stats = { added: 0, updated: 0, removed: 0 };
    for (const ev of await cal.listTactEvents(calendarId)) {
      const key = ev.extendedProperties.private.tactKey;
      if (existing.has(key)) {
        await cal.remove(calendarId, ev.id); // 重複
        stats.removed++;
      } else {
        existing.set(key, ev);
      }
    }

    for (const t of wanted) {
      const body = eventBody(t);
      const ev = existing.get(t.key);
      if (!ev) {
        await cal.insert(calendarId, body);
        stats.added++;
      } else if (needsUpdate(ev, body)) {
        await cal.patch(calendarId, ev.id, body);
        stats.updated++;
      }
    }

    const selectedIds = new Set(sites.map((s) => s.id));
    for (const [key, ev] of existing) {
      const siteId = ev.extendedProperties.private.tactSite;
      const t = tasks.get(key);
      let remove;
      if (!selectedIds.has(siteId)) remove = true; // 同期対象から外した講義
      else if (failed.has(key[0] + ':' + siteId)) remove = false; // 取得失敗時は触らない
      else if (!t) remove = true; // TACT から消えた課題
      else remove = isDone(t); // 提出済み・手動完了
      if (remove) {
        await cal.remove(calendarId, ev.id);
        stats.removed++;
      }
    }

    // 管理画面表示用
    const taskList = [...tasks.values()]
      .filter((t) => t.due && t.due > now - PAST_WINDOW)
      .sort((a, b) => a.due - b.due)
      .map((t) => ({ ...t, done: isDone(t) }));
    await chrome.storage.local.set({ tasks: taskList });

    const urgent = wanted.filter((t) => t.due > now && t.due < now + 3 * DAY).length;
    await setStatus({ ok: true, ...stats, urgent, warnings });
    return { ...stats, urgent, warnings };
  } catch (e) {
    const error = e instanceof TactAuthError ? 'TACTにログインしてください' : e.message || String(e);
    await setStatus({ ok: false, error });
    throw new Error(error);
  }
}
