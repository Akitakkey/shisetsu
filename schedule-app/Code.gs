// ===== 設定 =====
const DRY_RUN = false;

// ===== 新カスタムラベル（eventLabelId）対応 =====
// Googleカレンダーの新しい「カスタムラベル」機能に対応する。担当者は色ではなくラベルで識別する。
// 旧11色（colorId）方式の名残は 2026-08-08 に全て撤去した。担当者はラベルだけで識別する。
// ※拡張サービス（Google Calendar API）の有効化が必要。GASエディタの「サービス」から追加すること。

// ラベルが付いていない予定に割り当てる擬似キー（旧 colorId '11' の代わり）
const LABEL_NONE = '__none__';
const LABEL_NONE_HEX = '#d50000';
const LABEL_CACHE_KEY = 'event_labels_v1';

// 画面の列の並び順を手で決めるための設定。
// スクリプトプロパティ COLUMN_ORDER に「秋田,小久保,長川,…」とカンマ区切りで書くと、その順に左から並ぶ。
// ・ここに書かれていない人は、今までどおり シフト表の順 → カレンダーの順 で後ろに付く
// ・「未登録」列は設定に関わらず常に右端
// ・書き換えると自動で反映される（clearLabelCache の実行は不要）
const COLUMN_ORDER_KEY = 'COLUMN_ORDER';

// 表示を速くするための一時保存（キャッシュ）
const ROSTER_CACHE_PREFIX = 'roster_v1_';   // 担当者一覧。ラベル名を変えたら clearLabelCache で消す
const LABELMAP_GEN_KEY = 'LABELMAP_GEN';    // 担当を書き換えたときに索引をまとめて捨てるための世代番号
const LABELMAP_CACHE_SEC = 300;             // 索引を覚えておく秒数（5分）

// 担当を書き換えた直後、それがカレンダー側の一覧に出てくるまで15〜20秒かかる。
// その間だけ「いま書いた担当」を覚えておき、画面には先にそちらを見せる。
// ※もし「更新を押すと一瞬もとに戻る」が再発したら、この秒数を増やす
const LABEL_PENDING_PREFIX = 'lblpend_';
const LABEL_PENDING_SEC = 30;

// 姓によくある異体字を吸収する。カレンダーのラベル名とシフト表の見出しを突き合わせるために使う
// 例: カレンダー「栁川」 ⇄ シフト表「柳川」
const NAME_VARIANTS = {
  '栁':'柳','髙':'高','﨑':'崎','濵':'浜','濱':'浜','嶋':'島','嶌':'島',
  '齋':'斎','齊':'斉','邉':'辺','邊':'辺','澤':'沢','瀨':'瀬','眞':'真',
  '德':'徳','惠':'恵','國':'国','寳':'宝','舘':'館','桒':'桑','曻':'昇',
};

function normName_(s) {
  const t = String(s || '').replace(/[\s　]/g, '');
  return Array.from(t).map(ch => NAME_VARIANTS[ch] || ch).join('');
}

function getCalendarId_() {
  return PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
}

// 列の並び順の設定を、書いたそのままの文字列で読む
function getColumnOrderRaw_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(COLUMN_ORDER_KEY) || '';
  } catch (e) {
    return '';
  }
}

// カンマ・読点・空白・改行のどれで区切っても読めるようにする
function parseColumnOrder_(raw) {
  return String(raw || '')
    .split(/[,、，\s　]+/)
    .map(s => normName_(s))
    .filter(s => s);
}

// 設定を書き換えたら担当者一覧を作り直させるための短い目印
function shortHash_(s) {
  if (!s) return '0';
  try {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
    return bytes.slice(0, 4).map(b => ((b & 0xff) + 0x100).toString(16).slice(1)).join('');
  } catch (e) {
    return String(s.length);
  }
}

// 担当者一覧のキャッシュキー。並び順の設定を変えると別のキーになり、古いものは自然に無効になる
function rosterCacheKey_(year, month) {
  return ROSTER_CACHE_PREFIX + shortHash_(getColumnOrderRaw_()) + '_' + year + '_' + month;
}

// 旧colorId（'1'〜'11'）と新ラベルID（UUID）を区別する
function isLabelId_(v) {
  return !!v && v !== LABEL_NONE && String(v).length > 4;
}

// カレンダーに設定されているラベル一覧（名前が入っている枠のみ）。1時間キャッシュ
function getEventLabels_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(LABEL_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const calId = getCalendarId_();
  if (!calId) return [];

  let labels = [];
  try {
    const res = Calendar.Calendars.get(calId, { fields: 'labelProperties' });
    labels = (res.labelProperties && res.labelProperties.eventLabels) || [];
  } catch (e) {
    Logger.log('getEventLabels_ 失敗: ' + e.message);
    return [];
  }

  const list = labels
    .filter(lb => lb.id && String(lb.name || '').trim())
    .map(lb => ({
      color: lb.id,
      name: String(lb.name).trim(),
      hex: lb.backgroundColor || '#888',
    }));

  try { cache.put(LABEL_CACHE_KEY, JSON.stringify(list), 3600); } catch (e) {}
  return list;
}

// ラベル名を変えた直後に反映させたいとき、GASエディタから手動実行する
function clearLabelCache() {
  const keys = [LABEL_CACHE_KEY];
  // 担当者一覧は月ごとに覚えているので、前月・当月・翌月ぶんを消す
  const now = new Date();
  for (let i = -1; i <= 1; i++) {
    const t = new Date(now.getFullYear(), now.getMonth() + i, 1);
    keys.push(rosterCacheKey_(t.getFullYear(), t.getMonth() + 1));
  }
  CacheService.getScriptCache().removeAll(keys);
  bumpLabelMapGen_();
  Logger.log('ラベル・担当者一覧・担当の索引のキャッシュを消しました');
  return { ok: true };
}

// いまの並び順を COLUMN_ORDER に貼れる形で出す。GASエディタから手動実行する
function showColumnOrder() {
  const names = buildRoster_().filter(p => !p.isUnassigned).map(p => p.name);
  const raw = getColumnOrderRaw_();
  Logger.log('いまの COLUMN_ORDER : ' + (raw || '(未設定＝シフト表の順)'));
  Logger.log('');
  Logger.log('いまの列の並び（これをコピーして COLUMN_ORDER に貼り、順番を入れ替えてください）:');
  Logger.log('');
  Logger.log(names.join(','));
  Logger.log('');
  Logger.log('※「未登録」は設定に関わらず常に右端なので、上の一覧には入れていません');
  return names.join(',');
}

// シフト表の見出し行から、担当者の並び順を取り出す（異体字は正規化済みのキーで返す）
function getShiftNameOrder_(year, month) {
  const ssId = PropertiesService.getScriptProperties().getProperty('SHIFT_SPREADSHEET_ID');
  if (!ssId) return [];

  const cacheKey = 'shiftorder_' + ssId.slice(-8) + '_' + year + '_' + month;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  let order = [];
  try {
    const ss = SpreadsheetApp.openById(ssId);
    let sheet = ss.getSheetByName(year + '年' + month + '月');
    if (!sheet) {
      sheet = ss.getSheets().find(s => {
        const n = s.getName();
        return n.includes(String(year)) && n.includes(String(month) + '月');
      }) || null;
    }
    if (!sheet) return [];

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return [];

    // ラベルに存在する名前だけを、見出し行の左から順に拾う
    // （「日付」「曜」「備考」等の人名でない見出しや、ラベルの無い人は自動的に落ちる）
    const labelKeys = {};
    getEventLabels_().forEach(lb => { labelKeys[normName_(lb.name)] = true; });

    const data = sheet.getRange(1, 1, Math.min(lastRow, 30), lastCol).getValues();
    for (let r = 0; r < data.length; r++) {
      const found = [];
      let hasDateHeader = false;
      data[r].forEach(v => {
        const s = String(v || '').trim();
        if (!s) return;
        if (s === '日付') { hasDateHeader = true; return; }
        const key = normName_(s);
        if (labelKeys[key] && found.indexOf(key) < 0) found.push(key);
      });
      if (hasDateHeader && found.length >= 3) { order = found; break; }
    }
  } catch (e) {
    Logger.log('getShiftNameOrder_ 失敗: ' + e.message);
    return [];
  }

  try { cache.put(cacheKey, JSON.stringify(order), 3600); } catch (e) {}
  return order;
}

// 担当者一覧。シフト表の並び順を適用し、末尾に「未登録」を置く
function buildRoster_(dateString) {
  const date = dateString ? new Date(dateString) : new Date();
  const y = date.getFullYear();
  const mo = date.getMonth() + 1;

  // 組み立て済みのものを覚えておく（ラベル取得とシフト表読みを毎回やらずに済む）
  const cacheKey = rosterCacheKey_(y, mo);
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const labels = getEventLabels_();
  const order = getShiftNameOrder_(y, mo);

  const rank = {};
  order.forEach((key, i) => { if (!(key in rank)) rank[key] = i; });

  // COLUMN_ORDER に書かれた人が最優先。書いていない人は今までどおりの順で後ろに付く
  const manual = {};
  parseColumnOrder_(getColumnOrderRaw_()).forEach((key, i) => {
    if (!(key in manual)) manual[key] = i;
  });

  const roster = labels
    .map((lb, i) => {
      const key = normName_(lb.name);
      let pos;
      if (key in manual) pos = manual[key];            // ①手で決めた順
      else if (key in rank) pos = 1000 + rank[key];    // ②シフト表の順
      else pos = 2000 + i;                             // ③カレンダーの順（一般職・内勤者など）
      return { lb: lb, pos: pos };
    })
    .sort((a, b) => a.pos - b.pos)
    .map(x => ({ color: x.lb.color, name: x.lb.name, hex: x.lb.hex }));

  roster.push({ color: LABEL_NONE, name: '未登録', hex: LABEL_NONE_HEX, isUnassigned: true });

  // ラベルが1件も取れなかったときは覚えない（一時的な失敗を1時間引きずらないため）
  if (labels.length) {
    try { cache.put(cacheKey, JSON.stringify(roster), 3600); } catch (e) {}
  }
  return roster;
}

// 担当を書き換えたときに、覚えている索引をまとめて捨てるための世代番号
function getLabelMapGen_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(LABELMAP_GEN_KEY) || '0';
  } catch (e) {
    return '0';
  }
}

// 世代番号を進める＝いま覚えている索引が全部「古いもの」になる
function bumpLabelMapGen_() {
  try {
    PropertiesService.getScriptProperties().setProperty(LABELMAP_GEN_KEY, String(Date.now()));
  } catch (e) {}
}

// 期間内の予定について { イベントID: ラベルID } の索引をつくる
function getEventLabelMap_(calId, from, to) {
  const byId = {};
  const byRecurring = {};
  if (!calId) return { byId: byId, byRecurring: byRecurring };

  // 同じ日を続けて開いたときのために少しの間だけ覚えておく。
  // 担当を書き換えると世代番号が変わり、ここは全部作り直しになる。
  const tz = Session.getScriptTimeZone();
  const cacheKey = 'lblmap_' + getLabelMapGen_() + '_' + calId.slice(-8) + '_' +
    Utilities.formatDate(from, tz, 'yyyyMMdd') + '_' + Utilities.formatDate(to, tz, 'yyyyMMdd');
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  let pageToken = null;
  let page = 0;
  try {
    do {
      const res = Calendar.Events.list(calId, {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,          // 繰り返し予定を1回ごとに展開する（必須）
        maxResults: 2500,
        eventLabelVersion: 1,        // ラベルを返してもらうために必須
        pageToken: pageToken,
        fields: 'items(id,eventLabelId,recurringEventId),nextPageToken',
      });
      (res.items || []).forEach(it => {
        if (!it.eventLabelId) return;
        byId[it.id] = it.eventLabelId;
        // 繰り返し予定は CalendarApp 側がシリーズIDを返すため、そちらからも引けるようにする
        if (it.recurringEventId) byRecurring[it.recurringEventId] = it.eventLabelId;
      });
      pageToken = res.nextPageToken;
    } while (pageToken && ++page < 20);
  } catch (e) {
    Logger.log('getEventLabelMap_ 失敗: ' + e.message);
    return { byId: byId, byRecurring: byRecurring };  // 失敗したものは覚えない
  }

  const result = { byId: byId, byRecurring: byRecurring };
  const json = JSON.stringify(result);
  // 患者検索など期間の広い呼び出しは大きくなりすぎるので、その場合は覚えない
  if (json.length < 90000) {
    try { cache.put(cacheKey, json, LABELMAP_CACHE_SEC); } catch (e) {}
  }
  return result;
}

// いま書き込んだ担当を短い間だけ覚えておく
function rememberPendingLabel_(calendarAppEventId, labelId) {
  try {
    const bare = String(calendarAppEventId || '').split('@')[0];
    if (!bare || !labelId) return;
    CacheService.getScriptCache().put(LABEL_PENDING_PREFIX + bare, labelId, LABEL_PENDING_SEC);
  } catch (e) {}
}

// 覚えている担当を索引にかぶせる。
// ※カレンダー側の一覧に出てくるまでの十数秒、画面が一瞬だけ元の担当に戻るのを防ぐ
function applyPendingLabels_(labelMap, events) {
  if (!labelMap || !events || !events.length) return labelMap;
  try {
    const keys = events.map(e => LABEL_PENDING_PREFIX + String(e.getId()).split('@')[0]);
    const found = CacheService.getScriptCache().getAll(keys);
    Object.keys(found || {}).forEach(k => {
      labelMap.byId[k.slice(LABEL_PENDING_PREFIX.length)] = found[k];
    });
  } catch (e) {}
  return labelMap;
}

function lookupLabel_(labelMap, calendarAppEventId) {
  if (!labelMap) return LABEL_NONE;
  const bare = String(calendarAppEventId || '').split('@')[0];
  return labelMap.byId[bare] || labelMap.byRecurring[bare] || LABEL_NONE;
}

// 直前の担当書き込みが失敗した理由。画面に出すために覚えておく
let LAST_LABEL_ERROR = '';
let LAST_RESOLVE_SCANNED = 0;

// CalendarApp のイベントに対応する、書き込み先のイベントIDを特定する
// ※繰り返し予定では CalendarApp 側のIDがシリーズ全体を指すことがあり、
//   それをそのまま書き込むと全ての回に波及してしまう。必ずその回のIDを引き当てる。
function resolveAdvancedEventId_(calId, ev) {
  LAST_RESOLVE_SCANNED = 0;
  if (!calId || !ev) return null;
  const bare = String(ev.getId() || '').split('@')[0];
  const startMs = ev.getStartTime().getTime();
  const startYmd = Utilities.formatDate(ev.getStartTime(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const from = new Date(ev.getStartTime()); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 1);

  const all = [];
  let pageToken = null;
  let page = 0;
  try {
    do {
      const res = Calendar.Events.list(calId, {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        maxResults: 2500,
        pageToken: pageToken,
        fields: 'items(id,recurringEventId,start),nextPageToken',
      });
      const items = res.items || [];
      LAST_RESOLVE_SCANNED += items.length;
      items.forEach(it => all.push(it));
      pageToken = res.nextPageToken;
    } while (pageToken && ++page < 20);
  } catch (e) {
    Logger.log('resolveAdvancedEventId_ 失敗: ' + e.message);
    LAST_LABEL_ERROR = 'カレンダーの読み取りに失敗: ' + e.message;
    return null;
  }

  // 単発予定：IDがそのまま一致する
  const direct = all.find(it => it.id === bare);
  if (direct) return direct.id;

  // 繰り返し予定：シリーズIDが一致する回のうち、開始日時も合うものを選ぶ
  const sameSeries = all.filter(it => it.recurringEventId === bare);
  const inst = sameSeries.find(it => {
    if (!it.start) return false;
    if (it.start.dateTime) {
      return Math.abs(new Date(it.start.dateTime).getTime() - startMs) < 60000;
    }
    // 終日予定は時刻を持たないので日付だけで合わせる
    return it.start.date === startYmd;
  });
  if (inst) return inst.id;

  // 開始時刻が合うものが無いとき、その日にその繰り返しの回が1つだけなら、それを使う。
  // ※時刻を動かした直後は、カレンダー側の反映が少し遅れて古い時刻が返ることがある
  if (sameSeries.length === 1) return sameSeries[0].id;

  return null;
}

// 担当（ラベル）を書き込む。成功したら true。
// ※失敗した理由は LAST_LABEL_ERROR に入る。呼び出し側は必ず戻り値を見ること。
function patchEventLabel_(calId, ev, labelId) {
  LAST_LABEL_ERROR = '';
  if (!isLabelId_(labelId)) return false;   // 担当の指定なし。失敗ではない
  if (!calId) { LAST_LABEL_ERROR = 'CALENDAR_ID が設定されていません'; return false; }
  if (!ev) { LAST_LABEL_ERROR = '対象の予定が見つかりません'; return false; }

  const bare = String(ev.getId() || '').split('@')[0];
  const ymd = Utilities.formatDate(ev.getStartTime(), Session.getScriptTimeZone(), 'M/d HH:mm');

  const targetId = resolveAdvancedEventId_(calId, ev);
  if (!targetId) {
    if (!LAST_LABEL_ERROR) {
      LAST_LABEL_ERROR = '書き込み先を特定できません（' + ymd + ' の予定 '
        + LAST_RESOLVE_SCANNED + '件と照合、探したID=' + bare + '）';
    }
    Logger.log('patchEventLabel_: ' + LAST_LABEL_ERROR + ' 件名=' + ev.getTitle());
    return false;
  }

  try {
    Calendar.Events.patch({ eventLabelId: labelId }, calId, targetId, { eventLabelVersion: 1 });
  } catch (e) {
    LAST_LABEL_ERROR = 'カレンダーが書き込みを拒否: ' + e.message + '（ID=' + targetId + '）';
    Logger.log('patchEventLabel_ 失敗: ' + LAST_LABEL_ERROR);
    return false;
  }

  // 書き込みが通っても、あとから元の担当に戻ってしまうことがある。
  // 「通った」で終わらせず、読み直して確かめる。
  let actual = '';
  try {
    const after = Calendar.Events.get(calId, targetId, { eventLabelVersion: 1 });
    actual = after.eventLabelId || '';
  } catch (e) {
    // 読めなかったときは判断できないので、成功扱いのままにする
  }

  // 読み直せて、かつ希望と違う担当が入っていたときだけ失敗とみなす。
  // （読めなかった場合は判断できないので、成功扱いのままにする）
  if (actual && actual !== labelId) {
    LAST_LABEL_ERROR = 'カレンダーが元の担当に戻しました（書き込みは通りましたが定着しません）';
    Logger.log('patchEventLabel_: ' + LAST_LABEL_ERROR + ' 希望=' + labelId + ' 実際=' + actual);
    return false;
  }

  bumpLabelMapGen_();  // 覚えている索引を捨てる（次の描画で新しい担当が出るように）
  // カレンダー側の一覧に出てくるまで十数秒かかるので、その間は画面にこちらを見せる
  rememberPendingLabel_(ev.getId(), labelId);
  return true;
}

// 担当の指定があったのに書き込めなかったときだけ、理由を画面に返す
function withLabelResult_(result, requestedLabelId, labelOk) {
  if (isLabelId_(requestedLabelId) && !labelOk) {
    result.labelOk = false;
    result.labelError = LAST_LABEL_ERROR || '原因不明';
  }
  return result;
}

// ===== Webアプリ =====
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('訪問スケジュール')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getCalendar_() {
  const calId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  if (!calId) throw new Error('スクリプトプロパティに CALENDAR_ID を設定してください');
  return CalendarApp.getCalendarById(calId);
}

function getSchedule(dateString) {
  const cal = getCalendar_();
  const date = dateString ? new Date(dateString) : new Date();
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  // 終日予定は時間軸に置けず画面に出せないので、担当者の件数からも外す
  const rawEvents = cal.getEvents(start, end).filter(ev => !ev.isAllDayEvent());

  const labelMap = applyPendingLabels_(
    getEventLabelMap_(getCalendarId_(), start, end), rawEvents);

  const events = rawEvents
    .map(ev => ({
      id: ev.getId(),
      title: ev.getTitle(),
      location: ev.getLocation(),
      description: ev.getDescription(),
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString(),
      color: lookupLabel_(labelMap, ev.getId()),
    }));

  const roster = buildRoster_(dateString);
  const usedColors = new Set(events.map(e => e.color));

  // その日に予定がある担当者だけを列にする
  const pharmacists = roster.filter(p => usedColors.has(p.color));

  // ロスターに無いラベルが使われていた場合も列は必ず作る（予定が画面から消えるのを防ぐ）
  const known = new Set(roster.map(p => p.color));
  usedColors.forEach(c => {
    if (!known.has(c)) pharmacists.push({ color: c, name: '(不明)', hex: '#888' });
  });

  return {
    events,
    pharmacists,
    allPharmacists: roster,
    dryRun: DRY_RUN,
  };
}

// ===== 次回検索の範囲 =====
// 一括先読みと個別検索の上限を同じ日数にしてあるので、個別検索で見つかる患者は
// 原理的に全員一括先読みでも見つかる（＝個別検索に落ちるのはタイムアウトか、本当に
// 見つからない場合だけになる）
// ※どちらかを変えたら index.html の searchedWeeks の既定値（週数）も揃えること
const NEXT_PREFETCH_DAYS = 42;   // 一括先読み（6週）
const NEXT_FALLBACK_DAYS = 42;   // 個別検索の上限（6週）

// ===== 次回訪問一括プリフェッチ =====
// 繰り返し予定はseriesIdで、単発予定はタイトル一致(matchKey_)で次回を探す。
// タイトルにコメント等が付いていても、繰り返し予定ならseriesIdが揺らがないため正しく次回を拾える。
function getNextVisitMapForDate(dateString, items) {
  const list = (items || []).filter(it => it && it.id);
  if (!list.length) return {};

  const cal = getCalendar_();
  const date = new Date(dateString);
  const todayStart = new Date(date); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);
  const from = new Date(todayStart); from.setDate(from.getDate() + 1);
  const to = new Date(from); to.setDate(to.getDate() + NEXT_PREFETCH_DAYS);

  // isRecurring_/getSeriesId_ はイベントオブジェクトを要求するため、今日の予定も取得してID→オブジェクトを引けるようにする
  const todayById = {};
  cal.getEvents(todayStart, todayEnd).forEach(ev => { todayById[ev.getId()] = ev; });

  const futureEvents = cal.getEvents(from, to);

  // 未来イベントを1回だけ走査し、seriesId別・タイトル別の索引を作っておく（毎回全件フィルタしない）
  const bySeriesId = {};
  const byTitle = {};
  futureEvents.forEach(ev => {
    const sid = getSeriesId_(ev);
    (bySeriesId[sid] = bySeriesId[sid] || []).push(ev);
    const key = matchKey_(ev.getTitle());
    (byTitle[key] = byTitle[key] || []).push(ev);
  });
  const earliest_ = evs => evs.reduce((a, b) => a.getStartTime() < b.getStartTime() ? a : b);

  const map = {};
  list.forEach(({ id, title }) => {
    const curEv = todayById[id];
    if (!curEv) return;
    const recurring = isRecurring_(curEv);
    if (recurring) {
      let seriesCands = bySeriesId[getSeriesId_(curEv)] || [];
      if (!seriesCands.length) {
        // 日程変更でGoogleカレンダー側がシリーズを分割していると、seriesIdでは拾えない。
        // getNextVisitInfo/confirmNextVisit と同じく、タイトル一致で保険の再検索をする
        seriesCands = (byTitle[matchKey_(title || '')] || []).filter(ev => isRecurring_(ev));
      }
      if (!seriesCands.length) return;
      const seriesNext = earliest_(seriesCands);
      // seriesNextは必ず繰り返しシリーズのインスタンスなので、タグ不一致警告用に常にタグを載せる
      const entry = { nextDate: ymd_(seriesNext.getStartTime()), nextEvTag: extractTag_(cleanTitle_(seriesNext.getTitle())) };
      const rinjiCands = (byTitle[matchKey_(title || '')] || [])
        .filter(ev => !isRecurring_(ev) && ev.getStartTime() < seriesNext.getStartTime());
      if (rinjiCands.length) {
        const rinjiEv = earliest_(rinjiCands);
        entry.rinjiFound = true;
        entry.rinjiEventId = rinjiEv.getId();
        entry.rinjiDate = ymd_(rinjiEv.getStartTime());
      }
      map[id] = entry;
    } else {
      const candidates = byTitle[matchKey_(title || '')] || [];
      if (candidates.length) {
        const nextEv = earliest_(candidates);
        const entry = { nextDate: ymd_(nextEv.getStartTime()) };
        if (isRecurring_(nextEv)) entry.nextEvTag = extractTag_(cleanTitle_(nextEv.getTitle()));
        map[id] = entry;
      }
    }
  });

  return map;
}

// ===== 次回確認 =====
// 表示・書き戻し用：システムタグ（👌・末尾の【次回...】）だけ除去。カスタムタグ（【午前中】等）は保持
function cleanTitle_(t) {
  return t.replace(/^👌\s*/, '').replace(/【次回[^】]*】$/, '').trim();
}

// マッチング専用：すべての【】タグを除去し、スペース・異体字も正規化（表記ゆれに左右されず一致させる）
function matchKey_(t) {
  return normName_(cleanTitle_(t).replace(/【[^】]*】/g, ''));
}

// タグ不一致警告用：cleanTitle済みの文字列から【】タグを全て取り出して連結する。無ければ空文字
// ※運用ルール上、複数タグは【AM希望】【臨時】のように分けて書くため、必ず全件を対象にする
function extractTag_(cleanTitle) {
  const m = cleanTitle.match(/【[^】]*】/g);
  return m ? m.join('') : '';
}

// タグ不一致警告用：【】タグを除いた名前部分だけを返す
function stripTag_(cleanTitle) {
  return cleanTitle.replace(/【[^】]*】/g, '').trim();
}

// 繰り返しイベントのインスタンスIDは通常「シリーズID + 接尾辞(_20260823T090000Z@google.com等)」だが、
// 「一度も個別編集していないインスタンス」だけは接尾辞が付かずシリーズIDと完全に同じ文字列になる。
// ev.getEventSeries()で毎回シリーズを取り直すとカレンダーAPI呼び出しが激増しクォータ超過を起こすため、
// 「繰り返しかどうか」はisRecurringEvent()（軽量）で判定し、シリーズIDはID文字列の接尾辞除去だけで求める。
function getSeriesId_(ev) {
  return ev.getId().replace(/_\d{8}(T\d{6}Z)?@google\.com$/, '@google.com');
}

function isRecurring_(ev) {
  return ev.isRecurringEvent();
}

function getNextVisitInfo(eventId, currentDateStr, knownTitle) {
  const cal = getCalendar_();
  const date = new Date(currentDateStr);

  // isRecurring_/getSeriesId_ はイベントオブジェクトが必要なため、knownTitleがあっても今回のイベント自体は取得する
  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const curEv = cal.getEvents(dayStart, dayEnd).find(e => e.getId() === eventId);
  if (!curEv) throw new Error('イベントが見つかりません');
  const rawTitle = matchKey_(knownTitle || curEv.getTitle());

  const from = new Date(date); from.setDate(from.getDate() + 1); from.setHours(0, 0, 0, 0);
  const seriesId = getSeriesId_(curEv);
  const recurring = isRecurring_(curEv);

  const search = days => {
    const to = new Date(from); to.setDate(to.getDate() + days);
    const events = cal.getEvents(from, to);
    let matched = recurring
      ? events.filter(ev => isRecurring_(ev) && getSeriesId_(ev) === seriesId)
      : events.filter(ev => matchKey_(ev.getTitle()) === rawTitle);
    // 日程変更でGoogleカレンダー側がシリーズを分割し、以降のインスタンスIDが
    // 別系統（_R接尾辞など）になることがある。seriesId一致で0件の時だけ、
    // タイトル一致で保険の再検索をする
    if (recurring && !matched.length) {
      matched = events.filter(ev => isRecurring_(ev) && matchKey_(ev.getTitle()) === rawTitle);
    }
    return matched.sort((a, b) => a.getStartTime() - b.getStartTime());
  };

  let candidates = search(NEXT_PREFETCH_DAYS);
  if (!candidates.length) candidates = search(NEXT_FALLBACK_DAYS);

  // searchedWeeks: 見つからなかった時に画面へ出す「どこまで探したか」
  if (!candidates.length) {
    return { found: false, rawTitle, searchedWeeks: Math.round(NEXT_FALLBACK_DAYS / 7) };
  }

  const result = {
    found: true,
    rawTitle,
    nextDate: ymd_(candidates[0].getStartTime()),
    count: candidates.length,
  };

  // タグ不一致警告用：nextEv自身が繰り返しシリーズのインスタンスの場合のみ、そのタグを返す
  if (isRecurring_(candidates[0])) {
    result.nextEvTag = extractTag_(cleanTitle_(candidates[0].getTitle()));
  }

  // 繰り返しシリーズの場合のみ：シリーズ候補より前に、同名の臨時（単発）イベントがないか確認する
  if (recurring) {
    const seriesNext = candidates[0];
    const rinjiPool = cal.getEvents(from, seriesNext.getStartTime())
      .filter(ev => !isRecurring_(ev) && matchKey_(ev.getTitle()) === rawTitle)
      .sort((a, b) => a.getStartTime() - b.getStartTime());
    if (rinjiPool.length) {
      result.rinjiFound = true;
      result.rinjiEventId = rinjiPool[0].getId();
      result.rinjiDate = ymd_(rinjiPool[0].getStartTime());
    }
  }

  return result;
}

function confirmNextVisit(eventId, currentDateStr, newNextDateStr, isRinji, tagChoice, _force) {
  if (DRY_RUN && !_force) return { ok: true, dryRun: true };

  const cal = getCalendar_();
  const date = new Date(currentDateStr);
  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  const curEv = cal.getEvents(dayStart, dayEnd).find(e => e.getId() === eventId);
  if (!curEv) throw new Error('イベントが見つかりません');

  const cleanTitle = cleanTitle_(curEv.getTitle()); // 表示・書き戻し用（カスタムタグ保持）
  const matchKey = matchKey_(curEv.getTitle());     // マッチング専用（全タグ除去）

  const from = new Date(date); from.setDate(from.getDate() + 1); from.setHours(0, 0, 0, 0);
  const seriesId = getSeriesId_(curEv);
  const recurring = isRecurring_(curEv);

  const searchCandidates_ = days => {
    const to = new Date(from); to.setDate(to.getDate() + days);
    const events = cal.getEvents(from, to);
    let matched = recurring
      ? events.filter(ev => isRecurring_(ev) && getSeriesId_(ev) === seriesId)
      : events.filter(ev => matchKey_(ev.getTitle()) === matchKey);
    // 日程変更でGoogleカレンダー側がシリーズを分割し、以降のインスタンスIDが
    // 別系統（_R接尾辞など）になることがある。seriesId一致で0件の時だけ、
    // タイトル一致で保険の再検索をする
    if (recurring && !matched.length) {
      matched = events.filter(ev => isRecurring_(ev) && matchKey_(ev.getTitle()) === matchKey);
    }
    return matched.sort((a, b) => a.getStartTime() - b.getStartTime());
  };
  // 上限は getNextVisitInfo と必ず揃えること。
  // ここだけ広いと、モーダルに出した予定が消されていた場合に
  // ずっと先の回を勝手に見つけて👌を付けてしまう
  let candidates = searchCandidates_(NEXT_PREFETCH_DAYS);
  if (!candidates.length) candidates = searchCandidates_(NEXT_FALLBACK_DAYS);

  if (!candidates.length) throw new Error('次回予定が見つかりません（' + cleanTitle + '）');

  const nextEv = candidates[0];
  const nextDateStr = ymd_(nextEv.getStartTime());

  // 臨時訪問：新しい単発イベントを作成し、繰り返しシリーズはそのまま
  if (isRinji && newNextDateStr) {
    const rinjiTitle = '👌【臨時】' + cleanTitle;
    const targetDate = dateFromYmd_(newNextDateStr);
    targetDate.setHours(nextEv.getStartTime().getHours(), nextEv.getStartTime().getMinutes(), 0, 0);
    const duration = nextEv.getEndTime().getTime() - nextEv.getStartTime().getTime();
    const rinjiEnd = new Date(targetDate.getTime() + duration);
    const rinjiEv = cal.createEvent(rinjiTitle, targetDate, rinjiEnd, {
      location: nextEv.getLocation() || '',
      description: nextEv.getDescription() || '',
    });
    const color = nextEv.getColor();
    if (color) rinjiEv.setColor(color);
    // 新ラベルも元の予定からコピーする（忘れると臨時分だけ「未登録」列に出る）
    const calId = getCalendarId_();
    const srcDayStart = new Date(nextEv.getStartTime()); srcDayStart.setHours(0, 0, 0, 0);
    const srcDayEnd = new Date(srcDayStart); srcDayEnd.setDate(srcDayEnd.getDate() + 1);
    const srcLabel = lookupLabel_(getEventLabelMap_(calId, srcDayStart, srcDayEnd), nextEv.getId());
    patchEventLabel_(calId, rinjiEv, srcLabel);
    const currentTitle = cleanTitle + '【次回' + formatMD_(newNextDateStr) + '】';
    curEv.setTitle(currentTitle);
    writeAuditLog_('臨時追加', cleanTitle + '：' + newNextDateStr + '（繰り返しシリーズはそのまま）');
    const rinjiResult = { ok: true, newDate: newNextDateStr, shifted: 0, rinji: true, currentTitle };
    Object.assign(rinjiResult, checkKeikakushoForResult_(cleanTitle, currentDateStr, newNextDateStr));
    return rinjiResult;
  }

  // タグ不一致警告の選択結果を反映：次回側のタグを引き継ぐ場合のみnextTagを使う
  let writeTitle = cleanTitle;
  if (tagChoice === 'keep_next' && isRecurring_(nextEv)) {
    const nextTag = extractTag_(cleanTitle_(nextEv.getTitle()));
    writeTitle = stripTag_(cleanTitle) + nextTag;
  }

  let effectiveNextDate;
  if (newNextDateStr && newNextDateStr !== nextDateStr) {
    // 日程変更あり → deltaを計算して全後続イベントをずらす
    const oldMs = dateFromYmd_(nextDateStr).getTime();
    const newMs = dateFromYmd_(newNextDateStr).getTime();
    const deltaMs = newMs - oldMs;

    nextEv.setTitle('👌' + writeTitle);
    nextEv.setTime(
      new Date(nextEv.getStartTime().getTime() + deltaMs),
      new Date(nextEv.getEndTime().getTime() + deltaMs)
    );
    candidates.slice(1).forEach(ev => {
      ev.setTime(
        new Date(ev.getStartTime().getTime() + deltaMs),
        new Date(ev.getEndTime().getTime() + deltaMs)
      );
    });
    effectiveNextDate = newNextDateStr;
    writeAuditLog_('次回確認(日程変更)', cleanTitle + '：' + nextDateStr + ' → ' + newNextDateStr + '（後続' + (candidates.length - 1) + '件もずらし）');
  } else {
    nextEv.setTitle('👌' + writeTitle);
    effectiveNextDate = nextDateStr;
    writeAuditLog_('次回確認', cleanTitle + '：' + nextDateStr);
  }

  const currentTitle = cleanTitle + '【次回' + formatMD_(effectiveNextDate) + '】';
  curEv.setTitle(currentTitle);
  const result = {
    ok: true,
    newDate: effectiveNextDate,
    shifted: (newNextDateStr && newNextDateStr !== nextDateStr) ? candidates.length : 0,
    currentTitle,
  };
  Object.assign(result, checkKeikakushoForResult_(cleanTitle, currentDateStr, effectiveNextDate));
  return result;
}

// 繰り返しシリーズの次回候補より前に見つかった臨時（単発）イベントに直接👌を付ける
// （getNextVisitInfoのrinjiFound警告で「はい」を選んだ時に呼ばれる。タイトルは書き換えず、臨時イベント自身のタグを保持したまま👌だけ付け直す）
function confirmNextVisitOnRinji(eventId, currentDateStr, rinjiEventId, rinjiDateStr, _force) {
  if (DRY_RUN && !_force) return { ok: true, dryRun: true };

  const cal = getCalendar_();
  const date = new Date(currentDateStr);
  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  const curEv = cal.getEvents(dayStart, dayEnd).find(e => e.getId() === eventId);
  if (!curEv) throw new Error('イベントが見つかりません');
  const cleanTitle = cleanTitle_(curEv.getTitle());

  const rinjiDate = dateFromYmd_(rinjiDateStr);
  const rinjiDayStart = new Date(rinjiDate); rinjiDayStart.setHours(0, 0, 0, 0);
  const rinjiDayEnd = new Date(rinjiDayStart); rinjiDayEnd.setDate(rinjiDayEnd.getDate() + 1);
  let rinjiEv = cal.getEvents(rinjiDayStart, rinjiDayEnd).find(e => e.getId() === rinjiEventId);
  if (!rinjiEv) rinjiEv = cal.getEventById(rinjiEventId);
  if (!rinjiEv) throw new Error('臨時イベントが見つかりません');

  rinjiEv.setTitle('👌' + cleanTitle_(rinjiEv.getTitle()));

  const currentTitle = cleanTitle + '【次回' + formatMD_(rinjiDateStr) + '】';
  curEv.setTitle(currentTitle);

  writeAuditLog_('次回確認(臨時優先)', cleanTitle + '：' + rinjiDateStr);

  const result = { ok: true, newDate: rinjiDateStr, shifted: 0, currentTitle };
  Object.assign(result, checkKeikakushoForResult_(cleanTitle, currentDateStr, rinjiDateStr));
  return result;
}

function checkKeikakushoForResult_(patientName, currentDateStr, nextDateStr) {
  const cur  = new Date(currentDateStr);
  const next = dateFromYmd_(nextDateStr);
  if (cur.getFullYear() === next.getFullYear() && cur.getMonth() === next.getMonth()) return {};
  return {
    keikakusho: checkKeikakushoStatus(patientName, nextDateStr),
    keikakushoPatientName: patientName,
    keikakushoNextDate: nextDateStr,
  };
}

function ymd_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function formatMD_(ymdStr) {
  const p = ymdStr.split('-');
  return parseInt(p[1]) + '/' + parseInt(p[2]);
}

function timeFmt_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm');
}

function dateFromYmd_(ymdStr) {
  const p = ymdStr.split('-');
  return new Date(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2]));
}

// ===== 監査ログ =====
function writeAuditLog_(action, detail) {
  try {
    const id = PropertiesService.getScriptProperties().getProperty('PATIENT_MASTER_SPREADSHEET_ID');
    if (!id) return;
    const ss = SpreadsheetApp.openById(id);
    let sheet = ss.getSheetByName('操作ログ');
    if (!sheet) {
      sheet = ss.insertSheet('操作ログ');
      sheet.appendRow(['日時', 'ユーザー', '操作', '詳細']);
      sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#f1f3f4');
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([new Date(), Session.getActiveUser().getEmail() || '不明', action, detail]);
  } catch (e) {
    Logger.log('監査ログ書き込み失敗: ' + e.message);
  }
}

// ===== Phase 1: 患者マスタ =====
const MASTER_SPREADSHEET_NAME = '訪問患者マスタ';
const MASTER_SHEET_NAME = '患者マスタ';
const MASTER_HEADERS = [
  '名前', '住所', '緯度', '経度', 'ジオコード状態',
  '種別', '主担当色', '主担当名', '訪問頻度', '訪問曜日',
  '最終訪問日', '訪問回数(90日)', 'メモ',
];
const COL = {
  NAME: 0, ADDRESS: 1, LAT: 2, LNG: 3, GEO_STATUS: 4,
  CATEGORY: 5, MAIN_COLOR: 6, MAIN_NAME: 7, FREQUENCY: 8, WEEKDAYS: 9,
  LAST_VISIT: 10, VISIT_COUNT: 11, NOTE: 12,
};
const REBUILD_LOOKBACK_DAYS = 90;
const REBUILD_LOOKAHEAD_DAYS = 60;
const GEOCODE_BATCH_LIMIT = 50;

function getOrCreateMasterSheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('PATIENT_MASTER_SPREADSHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(MASTER_SPREADSHEET_NAME);
    props.setProperty('PATIENT_MASTER_SPREADSHEET_ID', ss.getId());
  }
  let sheet = ss.getSheetByName(MASTER_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(MASTER_SHEET_NAME);
  if (sheet.getLastRow() === 0 || sheet.getRange(1, 1).getValue() !== MASTER_HEADERS[0]) {
    sheet.clear();
    const hr = sheet.getRange(1, 1, 1, MASTER_HEADERS.length);
    hr.setValues([MASTER_HEADERS]);
    hr.setFontWeight('bold').setBackground('#f1f3f4');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(COL.NAME + 1, 160);
    sheet.setColumnWidth(COL.ADDRESS + 1, 240);
    sheet.setColumnWidth(COL.NOTE + 1, 240);
  }
  return sheet;
}

function patientMasterRebuild() {
  const cal = getCalendar_();
  const now = new Date();
  const past = new Date(now); past.setDate(past.getDate() - REBUILD_LOOKBACK_DAYS);
  const future = new Date(now); future.setDate(future.getDate() + REBUILD_LOOKAHEAD_DAYS);

  const events = cal.getEvents(past, future);
  const labelMap = getEventLabelMap_(getCalendarId_(), past, future);
  const TAG_BUSINESS = /【業務】|\[業務\]/;
  const TAG_FACILITY = /【施設】|\[施設\]/;
  const groups = {};
  events.forEach(ev => {
    const title = (ev.getTitle() || '').replace(/^👌\s*/, '').trim();
    if (!title) return;
    const desc = ev.getDescription() || '';
    if (!groups[title]) groups[title] = { items: [], hasBusiness: false, hasFacility: false };
    groups[title].items.push({ location: ev.getLocation() || '', start: ev.getStartTime(), color: lookupLabel_(labelMap, ev.getId()) });
    if (TAG_BUSINESS.test(desc)) groups[title].hasBusiness = true;
    if (TAG_FACILITY.test(desc)) groups[title].hasFacility = true;
  });

  const sheet = getOrCreateMasterSheet_();
  const existing = readMasterMap_(sheet);
  // ラベルID → 担当者名（「未登録」は入れない。下の '未設定' 分岐を生かすため）
  const names = {};
  buildRoster_().forEach(p => { if (!p.isUnassigned) names[p.color] = p.name; });
  const tz = Session.getScriptTimeZone();
  const rows = [];

  Object.keys(groups).forEach(name => {
    const g = groups[name];
    const list = g.items.slice().sort((a, b) => a.start - b.start);
    const addrCount = {};
    list.forEach(e => { if (e.location) addrCount[e.location] = (addrCount[e.location] || 0) + 1; });
    const address = Object.keys(addrCount).sort((a, b) => addrCount[b] - addrCount[a])[0] || '';
    if (g.hasBusiness || !address) return;

    const colorCount = {};
    list.forEach(e => { colorCount[e.color] = (colorCount[e.color] || 0) + 1; });
    const mainColor = Object.keys(colorCount).sort((a, b) => colorCount[b] - colorCount[a])[0] || '';
    const frequency = analyzeFrequency_(list.map(e => e.start));
    const wdSet = new Set(list.map(e => '日月火水木金土'.charAt(e.start.getDay())));
    const weekdays = '日月火水木金土'.split('').filter(d => wdSet.has(d)).join(',');
    const lastVisit = list[list.length - 1].start;
    const visitCount = list.filter(e => e.start >= past && e.start <= now).length;

    const ex = existing[name] || {};
    const sameAddr = ex.address === address;
    let category = ex.category;
    if (!category) category = g.hasFacility ? '施設' : '居宅';

    rows.push([
      name, address,
      sameAddr ? ex.lat : '', sameAddr ? ex.lng : '',
      sameAddr ? ex.geoStatus : (address ? '待ち' : ''),
      category, mainColor, names[mainColor] || (mainColor === LABEL_NONE ? '未設定' : ''),
      frequency, weekdays,
      Utilities.formatDate(lastVisit, tz, 'yyyy-MM-dd'),
      visitCount, ex.note || '',
    ]);
  });

  rows.sort((a, b) => String(a[COL.NAME]).localeCompare(String(b[COL.NAME]), 'ja'));
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, MASTER_HEADERS.length).clearContent();
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, MASTER_HEADERS.length).setValues(rows);

  Logger.log('患者マスタ更新完了: ' + rows.length + '件');
  Logger.log('スプレッドシートURL: ' + sheet.getParent().getUrl());
}

function readMasterMap_(sheet) {
  const map = {};
  if (sheet.getLastRow() < 2) return map;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, MASTER_HEADERS.length).getValues();
  data.forEach(row => {
    const name = row[COL.NAME];
    if (!name) return;
    map[name] = { address: row[COL.ADDRESS], lat: row[COL.LAT], lng: row[COL.LNG], geoStatus: row[COL.GEO_STATUS], category: row[COL.CATEGORY], note: row[COL.NOTE] };
  });
  return map;
}

function analyzeFrequency_(starts) {
  if (!starts || starts.length < 2) return '不定';
  const sorted = starts.slice().sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 86400000);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 9) return '毎週';
  if (median <= 17) return '隔週';
  if (median <= 35) return '月1';
  return '不定';
}

function geocodePending() {
  const sheet = getOrCreateMasterSheet_();
  if (sheet.getLastRow() < 2) { Logger.log('先に patientMasterRebuild を実行してください'); return; }
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, MASTER_HEADERS.length).getValues();
  const geocoder = Maps.newGeocoder().setLanguage('ja').setRegion('JP');
  let processed = 0, success = 0, failed = 0;
  for (let i = 0; i < data.length; i++) {
    if (processed >= GEOCODE_BATCH_LIMIT) break;
    const row = data[i];
    if (!row[COL.ADDRESS] || row[COL.GEO_STATUS] === 'OK') continue;
    processed++;
    try {
      const res = geocoder.geocode(row[COL.ADDRESS]);
      if (res.status === 'OK' && res.results && res.results.length > 0) {
        const loc = res.results[0].geometry.location;
        sheet.getRange(i + 2, COL.LAT + 1).setValue(loc.lat);
        sheet.getRange(i + 2, COL.LNG + 1).setValue(loc.lng);
        sheet.getRange(i + 2, COL.GEO_STATUS + 1).setValue('OK');
        success++;
      } else {
        sheet.getRange(i + 2, COL.GEO_STATUS + 1).setValue('NG: ' + res.status);
        failed++;
      }
    } catch (e) {
      sheet.getRange(i + 2, COL.GEO_STATUS + 1).setValue('NG: ' + e.message);
      failed++;
    }
    Utilities.sleep(100);
  }
  Logger.log('ジオコード: 処理=' + processed + ' 成功=' + success + ' 失敗=' + failed);
}

// ===== 単発イベント追加 =====
function addSingleEvent(colorId, title, startIso, endIso, location, description, _force) {
  if (DRY_RUN && !_force) return { ok: true, dryRun: true };
  const cal = getCalendar_();
  const ev = cal.createEvent(title, new Date(startIso), new Date(endIso), {
    location: location || '',
    description: description || '',
  });
  const labelOk = patchEventLabel_(getCalendarId_(), ev, colorId);
  writeAuditLog_('単発追加', title + '：' + startIso);
  return withLabelResult_({ ok: true, id: ev.getId() }, colorId, labelOk);
}

// ===== イベント全フィールド更新 =====
function updateEventFull(eventId, dateStr, params, memoFuture, _force) {
  // params: { title, startIso, endIso, memo }  memoFuture: メモをこの日以降全てに適用
  if (DRY_RUN && !_force) return { ok: true, dryRun: true };
  const cal = getCalendar_();
  const date = new Date(dateStr);
  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  let ev = cal.getEvents(dayStart, dayEnd).find(e => e.getId() === eventId);
  if (!ev) ev = cal.getEventById(eventId);
  if (!ev) throw new Error('イベントが見つかりません');

  const rawTitle = ev.getTitle().replace(/^👌\s*/, '').trim();

  if (params.title !== undefined) ev.setTitle(params.title);
  if (params.startIso && params.endIso) ev.setTime(new Date(params.startIso), new Date(params.endIso));
  if (params.memo !== undefined) ev.setDescription(params.memo);

  // 担当はいちばん最後に書く。
  // ※時刻や件名を先に変えないと、そのときアプリが持っている古い担当で上書きされてしまう
  const labelOk = patchEventLabel_(getCalendarId_(), ev, params.color);

  let memoCount = 1;
  if (memoFuture && params.memo !== undefined) {
    const from = new Date(date); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 365);
    cal.getEvents(from, to)
      .filter(e => e.getId() !== eventId && e.getTitle().replace(/^👌\s*/, '').trim() === rawTitle)
      .forEach(e => { e.setDescription(params.memo); memoCount++; });
  }

  writeAuditLog_('イベント更新', 'ID:' + eventId + (memoFuture ? '（メモ' + memoCount + '件）' : ''));
  return withLabelResult_({ ok: true, memoCount }, params.color, labelOk);
}

// ===== 患者マスタ住所検索 =====
function lookupPatientAddress(name) {
  try {
    const sheet = getOrCreateMasterSheet_();
    const data = sheet.getDataRange().getValues();
    const trimName = String(name || '').trim();
    if (!trimName) return { found: false };
    for (let i = 1; i < data.length; i++) {
      const rowName = String(data[i][0] || '').trim();
      if (rowName && rowName.includes(trimName)) {
        return { found: true, address: String(data[i][1] || '').trim() };
      }
    }
    return { found: false };
  } catch (e) {
    return { found: false };
  }
}

// ===== イベント削除（単発追加のUndo用）=====
function deleteEvent(eventId, dateStr, _force) {
  if (DRY_RUN && !_force) return { ok: true, dryRun: true };
  const cal = getCalendar_();
  let ev = null;
  if (dateStr) {
    const date = new Date(dateStr);
    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    ev = cal.getEvents(dayStart, dayEnd).find(e => e.getId() === eventId) || null;
  }
  if (!ev) ev = cal.getEventById(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  ev.deleteEvent();
  writeAuditLog_('イベント削除', 'ID:' + eventId);
  return { ok: true };
}

// ===== シフト表連携 =====
const SHIFT_STAFF_COLOR = {
  // 白背景グループ（秋田〜柳岡）
  '秋田':'2','小久保':'10','長川':'9','柳川':'8','阿部':'3',
  '増山':'6','一森':'1','坂川':'9','柳岡':'3',
  // 「外勤」テキスト明記のみグループ（伊東・神澤・瀧口・三宅・米倉）
  '伊東':'0','神澤':'0','瀧口':'0','三宅':'0','米倉':'4',
  // 〇またはチ福で外勤グループ
  '新井':'5',
  // 山口：除外
};

// 外勤判定グループ
const SHIFT_WHITE_BG   = new Set(['秋田','小久保','長川','柳川','阿部','増山','一森','坂川','柳岡']);
const SHIFT_TEXT_ONLY  = new Set(['伊東','神澤','瀧口','三宅','米倉']); // セルに「外勤」と入っている場合のみ
const SHIFT_MARU_CHIFUKU = new Set(['新井']); // 〇 or チ福

function setShiftSpreadsheetId(id) {
  PropertiesService.getScriptProperties().setProperty('SHIFT_SPREADSHEET_ID', String(id || '').trim());
  return { ok: true };
}

function getShiftSpreadsheetId() {
  return PropertiesService.getScriptProperties().getProperty('SHIFT_SPREADSHEET_ID') || '';
}

function buildShiftMonthMap_(ssId, year, month) {
  const ss = SpreadsheetApp.openById(ssId);
  const sheetName = year + '年' + month + '月';
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.getSheets().find(s => {
      const n = s.getName();
      return n.includes(String(year)) && n.includes(String(month) + '月');
    }) || null;
  }
  if (!sheet) return { _error: 'sheet_not_found' };

  const dataRange = sheet.getDataRange();
  const data = dataRange.getValues();
  const bgs  = dataRange.getBackgrounds();
  const allStaff = Object.keys(SHIFT_STAFF_COLOR);

  // ヘッダー行を探す（「日付」列 AND スタッフ名3人以上）
  let headerRow = -1;
  const colMap = {};
  let dateCol = 0;
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    let hasDateHeader = false, staffCount = 0;
    const tmpMap = {};
    let tmpDateCol = 0;
    row.forEach((v, c) => {
      const s = String(v || '').trim();
      if (s === '日付') { hasDateHeader = true; tmpDateCol = c; }
      if (allStaff.includes(s)) { tmpMap[s] = c; staffCount++; }
    });
    if (hasDateHeader && staffCount >= 3) {
      headerRow = r;
      Object.assign(colMap, tmpMap);
      dateCol = tmpDateCol;
      break;
    }
  }
  if (headerRow === -1) return { _error: 'header_not_found' };

  // 月によってグループを切り替え（米倉は2026年6月からグループ①に移籍）
  const effectiveWhiteBg  = new Set(SHIFT_WHITE_BG);
  const effectiveTextOnly = new Set(SHIFT_TEXT_ONLY);
  if (year > 2026 || (year === 2026 && month >= 6)) {
    effectiveWhiteBg.add('米倉');
    effectiveTextOnly.delete('米倉');
  }

  // 月全体の day → attendance[] マップを構築
  const map = {};
  for (let r = headerRow + 1; r < data.length; r++) {
    const v = data[r][dateCol];
    let m, d;
    if (v instanceof Date) {
      m = v.getMonth() + 1; d = v.getDate();
    } else {
      const match = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})$/);
      if (!match) continue;
      m = parseInt(match[1]); d = parseInt(match[2]);
    }
    if (m !== month) continue;

    const attendance = [];
    for (const name of allStaff) {
      const col = colMap[name];
      if (col === undefined) continue;
      const cellVal = String(data[r][col] || '').trim();
      const bg = (bgs[r] && bgs[r][col]) || '';
      const isWhite = !bg || bg.toLowerCase() === '#ffffff';
      let gaikon = false;
      if (effectiveWhiteBg.has(name)) {
        gaikon = isWhite;
      } else if (effectiveTextOnly.has(name)) {
        gaikon = cellVal.includes('外勤');
      } else if (SHIFT_MARU_CHIFUKU.has(name)) {
        gaikon = cellVal.includes('〇') || cellVal.includes('チ福');
      }
      if (gaikon) attendance.push({ name: name, color: SHIFT_STAFF_COLOR[name] });
    }
    map[d] = attendance;
  }
  return map;
}

function getShiftAttendance(dateString) {
  const ssId = PropertiesService.getScriptProperties().getProperty('SHIFT_SPREADSHEET_ID');
  if (!ssId) return { ok: false, reason: 'not_configured' };
  try {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    const cacheKey = 'shiftmap_' + ssId.slice(-8) + '_' + year + '_' + month;
    const cache = CacheService.getScriptCache();
    let map = null;
    const cached = cache.get(cacheKey);
    if (cached) {
      try { map = JSON.parse(cached); } catch (e) {}
    }
    if (!map) {
      map = buildShiftMonthMap_(ssId, year, month);
      if (map && !map._error) {
        try { cache.put(cacheKey, JSON.stringify(map), 3600); } catch (e) {}
      }
    }

    // シート名は画面のエラー表示に出す（どの月のシートを探したかを分かるようにする）
    const sheetName = year + '年' + month + '月';
    if (!map) return { ok: false, reason: 'sheet_not_found', sheetName: sheetName };
    if (map._error) return { ok: false, reason: map._error, sheetName: sheetName };

    return { ok: true, attendance: map[day] || [] };
  } catch (e) {
    return { ok: false, reason: 'error', error: e.message };
  }
}

// ===== 患者検索 =====
function searchPatients(query, currentDateStr, daysBack, daysForward) {
  if (!query || query.trim().length < 1) return { ok: true, results: [] };
  const cal = getCalendar_();
  const today = new Date(currentDateStr);
  today.setHours(0, 0, 0, 0);
  const back = daysBack || 0;
  const fwd = daysForward || 21;
  const from = new Date(today);
  from.setDate(from.getDate() - back);
  const to = new Date(today);
  to.setDate(to.getDate() + fwd);

  const q = query.trim().toLowerCase();
  const events = cal.getEvents(from, to).filter(ev => {
    const clean = ev.getTitle().replace(/^👌\s*/, '').replace(/【次回[^】]*】$/, '').trim();
    return clean.toLowerCase().includes(q);
  });

  // 担当者色（ラベル）の取得は別APIコールで重いため、検索結果には出さず省略する
  const grouped = {};
  events.forEach(ev => {
    const d = ymd_(ev.getStartTime());
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push({
      start: timeFmt_(ev.getStartTime()),
      end: timeFmt_(ev.getEndTime()),
      title: ev.getTitle(),
      location: ev.getLocation() || '',
    });
  });

  const results = Object.keys(grouped).sort().map(date => ({
    date,
    events: grouped[date].sort((a, b) => a.start.localeCompare(b.start)),
  }));

  return { ok: true, results, today: ymd_(today) };
}

// ===== 保留変更の一括反映 =====
function applyPendingChanges(changes) {
  const results = [];
  (changes || []).forEach(ch => {
    try {
      const a = ch.args || [];
      switch (ch.fn) {
        case 'moveEvent':        moveEvent(a[0],a[1],a[2],a[3],a[4],true); break;
        case 'addSingleEvent':   addSingleEvent(a[0],a[1],a[2],a[3],a[4],a[5],true); break;
        case 'deleteEvent':      deleteEvent(a[0],a[1],true); break;
        case 'updateEventFull':  updateEventFull(a[0],a[1],a[2],a[3],true); break;
        case 'confirmNextVisit': confirmNextVisit(a[0],a[1],a[2],a[3],a[4],true); break;
        case 'confirmNextVisitOnRinji': confirmNextVisitOnRinji(a[0],a[1],a[2],a[3],true); break;
        default: throw new Error('不明な操作: ' + ch.fn);
      }
      results.push({ ok: true });
    } catch (e) {
      results.push({ ok: false, error: e.message });
    }
  });
  const errors = results.filter(r => !r.ok);
  return { ok: true, applied: results.length - errors.length, errors };
}

// ===== D&D / リサイズ / 担当変更 =====
function moveEvent(eventId, newColor, newStartIso, newEndIso, originalDateStr, _force) {
  if (DRY_RUN && !_force) return { ok: true, dryRun: true };

  const cal = getCalendar_();
  let ev = null;
  if (originalDateStr) {
    const date = new Date(originalDateStr);
    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    ev = cal.getEvents(dayStart, dayEnd).find(e => e.getId() === eventId) || null;
  }
  if (!ev) ev = cal.getEventById(eventId);
  if (!ev) throw new Error('イベントが見つかりません');

  if (newStartIso || newEndIso) {
    const oldStart = ev.getStartTime();
    const oldEnd = ev.getEndTime();
    if (newStartIso && !newEndIso) {
      const duration = oldEnd.getTime() - oldStart.getTime();
      const ns = new Date(newStartIso);
      ev.setTime(ns, new Date(ns.getTime() + duration));
    } else if (!newStartIso && newEndIso) {
      ev.setTime(oldStart, new Date(newEndIso));
    } else {
      ev.setTime(new Date(newStartIso), new Date(newEndIso));
    }
  }

  // 担当はいちばん最後に書く。
  // ※時刻や件名を先に変えないと、そのときアプリが持っている古い担当で上書きされてしまう
  const labelOk = patchEventLabel_(getCalendarId_(), ev, newColor);

  writeAuditLog_('イベント変更', 'ID:' + eventId + (newColor ? ' 色→' + newColor : '') + (newStartIso ? ' 開始→' + newStartIso : ''));
  return withLabelResult_({ ok: true }, newColor, labelOk);
}

// ===== 初期データ一括取得（コールドスタートを1回に削減）=====
function getInitialData(dateString) {
  return {
    schedule: getSchedule(dateString),
    shift: getShiftAttendance(dateString),
  };
}

// ===== 仮担当（一時機能：期間終了後はこの関数を削除してよい）=====
// 表示中の日にある各予定について、患者（タイトル一致）ごとに過去半年の担当ラベルを
// 集計し、多い順のランキングを返す。「一番よく訪問している人」を仮担当の初期値として
// 画面側で提案するために使う。
const KARITANTO_LOOKBACK_DAYS = 180;

function getKaritantoSuggestions(dateString) {
  const cal = getCalendar_();
  const calId = getCalendarId_();
  const date = new Date(dateString);
  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  const todayEvents = cal.getEvents(dayStart, dayEnd);

  const from = new Date(dayStart); from.setDate(from.getDate() - KARITANTO_LOOKBACK_DAYS);
  const pastEvents = cal.getEvents(from, dayStart);
  const labelMap = getEventLabelMap_(calId, from, dayStart);

  // タイトル（表記ゆれ・タグ除去済み）ごとに、担当ラベル別の訪問件数を集計する
  const countsByTitle = {};
  pastEvents.forEach(ev => {
    const key = matchKey_(ev.getTitle());
    if (!key) return;
    const color = lookupLabel_(labelMap, ev.getId());
    if (!isLabelId_(color)) return; // 未登録（担当なし）の過去分は集計対象外
    if (!countsByTitle[key]) countsByTitle[key] = {};
    countsByTitle[key][color] = (countsByTitle[key][color] || 0) + 1;
  });

  const names = {};
  buildRoster_(dateString).forEach(p => { names[p.color] = p.name; });

  const ranking = {};
  todayEvents.forEach(ev => {
    const key = matchKey_(ev.getTitle());
    const counts = countsByTitle[key] || {};
    ranking[ev.getId()] = Object.keys(counts)
      .map(color => ({ color: color, name: names[color] || '(不明)', count: counts[color] }))
      .sort((a, b) => b.count - a.count);
  });

  return { ok: true, days: KARITANTO_LOOKBACK_DAYS, ranking: ranking };
}
