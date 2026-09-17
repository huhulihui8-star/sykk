export type ExchangeSession = 'CN' | 'US' | 'HK' | 'JP' | 'KR' | 'TW' | 'DE' | 'UK';
export const SESSION_WINDOWS = {
  CN: { timeZone: 'Asia/Shanghai', open: 570, close: 900, break: [690, 780] },
  US: { timeZone: 'America/New_York', open: 570, close: 960, break: [] },
  HK: { timeZone: 'Asia/Hong_Kong', open: 570, close: 970, break: [720, 780] },
  JP: { timeZone: 'Asia/Tokyo', open: 540, close: 930, break: [690, 750] },
  KR: { timeZone: 'Asia/Seoul', open: 540, close: 930, break: [] },
  TW: { timeZone: 'Asia/Taipei', open: 540, close: 810, break: [] },
  DE: { timeZone: 'Europe/Berlin', open: 540, close: 1050, break: [] },
  UK: { timeZone: 'Europe/London', open: 480, close: 990, break: [] },
} as const;

/** Only verified years are included. Sources and special-session limitations: MARKET-CALENDAR.md. */
export const EXCHANGE_CALENDARS = {
  CN: { years: [2026], source: 'https://www.sse.com.cn/disclosure/announcement/general/', dates: [] as string[] },
  US: { years: [2026, 2027], source: 'https://www.nyse.com/markets/hours-calendars', dates: [] as string[] },
  HK: { years: [2026], source: 'https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf', dates: [
    '2026-01-01','2026-02-17','2026-02-18','2026-02-19','2026-04-03','2026-04-06','2026-04-07',
    '2026-05-01','2026-05-25','2026-06-19','2026-07-01','2026-10-01','2026-10-19','2026-12-25',
  ] },
  JP: { years: [2026, 2027], source: 'https://www.jpx.co.jp/english/corporate/about-jpx/calendar/', dates: [
    '2026-01-01','2026-01-02','2026-01-03','2026-01-12','2026-02-11','2026-02-23','2026-03-20',
    '2026-04-29','2026-05-03','2026-05-04','2026-05-05','2026-05-06','2026-07-20','2026-08-11',
    '2026-09-21','2026-09-22','2026-09-23','2026-10-12','2026-11-03','2026-11-23','2026-12-31',
    '2027-01-01','2027-01-02','2027-01-03','2027-01-11','2027-02-11','2027-02-23','2027-03-21',
    '2027-03-22','2027-04-29','2027-05-03','2027-05-04','2027-05-05','2027-07-19','2027-08-11',
    '2027-09-20','2027-09-23','2027-10-11','2027-11-03','2027-11-23','2027-12-31',
  ] },
  KR: { years: [2026], source: 'https://global.krx.co.kr/contents/GLB/06/0606/0606030101/GLB0606030101T3.jsp', dates: [
    '2026-01-01','2026-02-16','2026-02-17','2026-02-18','2026-03-02','2026-05-01','2026-05-05',
    '2026-05-25','2026-06-03','2026-08-17','2026-09-24','2026-09-25','2026-10-05','2026-10-09',
    '2026-12-25','2026-12-31',
  ] },
  TW: { years: [2026], source: 'https://www.twse.com.tw/holidaySchedule/holidaySchedule?response=html', dates: [
    '2026-01-01','2026-02-12','2026-02-13','2026-02-16','2026-02-17','2026-02-18','2026-02-19',
    '2026-02-20','2026-02-27','2026-04-03','2026-04-06','2026-05-01','2026-06-19','2026-09-25',
    '2026-09-28','2026-10-09','2026-10-26','2026-12-25',
  ] },
  DE: { years: [2026, 2027], source: 'https://www.cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours', dates: [
    '2026-01-01','2026-04-03','2026-04-06','2026-05-01','2026-12-24','2026-12-25','2026-12-26','2026-12-31',
    '2027-01-01','2027-03-26','2027-03-29','2027-05-01','2027-12-24','2027-12-25','2027-12-26','2027-12-31',
  ] },
  UK: { years: [2026], source: 'https://www.londonstockexchange.com/equities-trading/business-days', dates: [
    '2026-01-01','2026-04-03','2026-04-06','2026-05-04','2026-05-25','2026-08-31','2026-12-25','2026-12-28',
  ] },
};

export function calendarCoverage(session: ExchangeSession, dateKey: string) {
  const calendar = EXCHANGE_CALENDARS[session];
  const covered = calendar.years.includes(Number(dateKey.slice(0, 4)));
  return { covered, years: calendar.years, source: calendar.source,
    message: covered ? '已覆盖官方休市日；临时停市须另行核实' : '该年份未覆盖官方休市日，仅按周末及常规时段判断' };
}

export function sessionForCode(code: string): ExchangeSession {
  if (code.startsWith('IDX-')) {
    const session = code.split('-')[1];
    if (session in SESSION_WINDOWS) return session as ExchangeSession;
  }
  return code.startsWith('US-') ? 'US' : 'CN';
}

export function localClock(session: ExchangeSession, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: SESSION_WINDOWS[session].timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return { dateKey: `${get('year')}-${get('month')}-${get('day')}`, weekday: get('weekday'), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function sessionClose(session: ExchangeSession, dateKey: string) {
  if (session === 'US' && ['2026-11-27','2026-12-24','2027-11-26'].includes(dateKey)) return 780;
  if (session === 'HK' && ['2026-02-16','2026-12-24','2026-12-31'].includes(dateKey)) return 730;
  if (session === 'UK' && ['2026-12-24','2026-12-31'].includes(dateKey)) return 750;
  return SESSION_WINDOWS[session].close;
}

export function shiftDate(dateKey: string, days: number) {
  return new Date(Date.parse(`${dateKey}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
