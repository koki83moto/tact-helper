import { runSync } from './lib/sync.js';

const ALARM = 'tact-sync';
// 6時間ごと(=1日に最低数回)同期。ブラウザが閉じていた分は起動時に同期する
const PERIOD_MIN = 6 * 60;
// TACT を開いたときの同期は、最後の同期からこの時間以上経っている場合のみ
const VISIT_THROTTLE = 60 * 60 * 1000;

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) {
    chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MIN });
  }
}

function quietSync() {
  runSync().catch((e) => console.warn('TACT sync failed:', e.message));
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  quietSync();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) quietSync();
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sync') {
    runSync({ interactive: !!msg.interactive }).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
  if (msg?.type === 'tactVisited') {
    // ログイン直後に TACT を開いたタイミングで同期(セッション切れ対策)
    chrome.storage.local.get('syncStatus').then(({ syncStatus }) => {
      if (!syncStatus || !syncStatus.ok || Date.now() - syncStatus.time > VISIT_THROTTLE) quietSync();
    });
  }
});
