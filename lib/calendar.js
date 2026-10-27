// Google Calendar API (chrome.identity でトークン取得)
const API = 'https://www.googleapis.com/calendar/v3';
export const CALENDAR_NAME = 'TACT 課題';

// 日本時間 0:00 締切は、直観的にわかるよう前日 23:59 として扱う
export function displayDue(due) {
  const JST = 9 * 60 * 60 * 1000;
  return (due + JST) % (24 * 60 * 60 * 1000) === 0 ? due - 60 * 1000 : due;
}

export async function getToken(interactive) {
  const r = await chrome.identity.getAuthToken({ interactive });
  const token = typeof r === 'string' ? r : r?.token;
  if (!token) throw new Error('Googleアカウントに接続されていません');
  return token;
}

export class Calendar {
  constructor(interactive = false) {
    this.interactive = interactive;
  }

  async api(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getToken(this.interactive);
      const res = await fetch(API + path, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        await chrome.identity.removeCachedAuthToken({ token });
        continue;
      }
      if (!res.ok) {
        const err = new Error(`Google Calendar ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
        err.status = res.status;
        throw err;
      }
      return res.status === 204 ? null : res.json();
    }
  }

  // 専用カレンダーを用意する(このカレンダー内の予定だけを操作する)
  async ensureCalendar(savedId) {
    if (savedId) {
      try {
        await this.api('GET', `/calendars/${encodeURIComponent(savedId)}`);
        return savedId;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    let pageToken = '';
    do {
      const list = await this.api('GET', `/users/me/calendarList?maxResults=250${pageToken ? '&pageToken=' + pageToken : ''}`);
      const found = (list.items || []).find((c) => c.summary === CALENDAR_NAME && c.accessRole === 'owner');
      if (found) return found.id;
      pageToken = list.nextPageToken || '';
    } while (pageToken);
    const cal = await this.api('POST', '/calendars', { summary: CALENDAR_NAME, timeZone: 'Asia/Tokyo' });
    return cal.id;
  }

  async listTactEvents(calendarId) {
    const events = [];
    let pageToken = '';
    do {
      const q = `maxResults=2500${pageToken ? '&pageToken=' + pageToken : ''}`;
      const r = await this.api('GET', `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      for (const ev of r.items || []) {
        if (ev.extendedProperties?.private?.tactKey) events.push(ev);
      }
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return events;
  }

  insert(calendarId, body) {
    return this.api('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body);
  }

  patch(calendarId, eventId, body) {
    return this.api('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, body);
  }

  async remove(calendarId, eventId) {
    try {
      await this.api('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }
}
