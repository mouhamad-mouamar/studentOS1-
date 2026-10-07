// Lightweight client-side study trackers (localStorage — no schema changes).
// "Today" activity counters and last-accessed course. All data is real user
// activity, never fabricated; counters reset naturally per calendar day.

const LAST_COURSE_KEY = 'studyos.lastCourse';
const ACTIVITY_KEY = 'studyos.activity';

export function rememberCourse(id: string, name: string) {
  try {
    localStorage.setItem(LAST_COURSE_KEY, JSON.stringify({ id, name, ts: Date.now() }));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function lastCourse(): { id: string; name: string } | null {
  try {
    const raw = localStorage.getItem(LAST_COURSE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v?.id && v?.name ? { id: v.id, name: v.name } : null;
  } catch {
    return null;
  }
}

type Activity = { date: string; quizzes: number; cards: number; sessions: number };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function read(): Activity {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || 'null');
    if (raw && raw.date === todayKey()) return { date: raw.date, quizzes: raw.quizzes || 0, cards: raw.cards || 0, sessions: raw.sessions || 0 };
  } catch {
    /* fall through */
  }
  return { date: todayKey(), quizzes: 0, cards: 0, sessions: 0 };
}

function write(a: Activity) {
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(a));
  } catch {
    /* non-fatal */
  }
}

export function noteActivity(kind: 'quiz' | 'cards' | 'session', n = 1) {
  const a = read();
  if (kind === 'quiz') a.quizzes += n;
  else if (kind === 'cards') a.cards += n;
  else a.sessions += n;
  write(a);
}

export function todayActivity(): Activity {
  return read();
}
