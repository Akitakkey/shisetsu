// eFAX送信支援（つなぐ薬局足立）
// ここが受け持つのは「送信先マスタ（スプレッドシート）の読み書き」と「eFAX宛のメール送信」だけ。
// 送信票づくり・別添の黒塗り・PDF化はすべて index.html 側で行い、ここには完成したPDFだけが届く。

var PHARMACY_NAME = 'つなぐ薬局足立';
// eFAXに送信元として登録してあるアドレス。別のアカウントでデプロイした場合は送る前に止める
var EFAX_SENDER = 'tsunagup.adachi@wise-jmco.com';
var SHEET_NAME = '送信先マスタ';
var HEADERS = ['送信先名', 'よみ', 'FAX番号', 'ピン留め'];
var HISTORY_SHEET_NAME = '送信履歴';
var HISTORY_HEADERS = ['送信日時', '送信先名', 'FAX番号', 'ファイル数', '送信者'];
var HISTORY_MAX_ROWS = 1000;   // これを超えたら古い行から間引く
// Gmailの添付上限25MBに対する安全マージン
var MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;
var STALE_MESSAGE = 'シートの内容が画面の表示と変わっています。画面を読み込み直してから、もう一度操作してください。';

// ---- 予約送信（時間指定） ----
var SCHEDULE_SHEET_NAME = '予約送信';
// ステータスとエラーは runScheduledFax が1回のsetValuesでまとめて書き込むため隣接させ、登録者は末尾に置く
var SCHEDULE_HEADERS = ['予約ID', '送信予定日時', '送信先名', 'FAX番号', 'ファイル数', 'ファイルID', 'トリガーID', 'ステータス', 'エラー', '登録者'];
var SCHEDULE_STATUS = { PENDING: '予約中', SENT: '送信済み', ERROR: 'エラー', CANCELED: 'キャンセル' };
var SCHEDULE_TRIGGER_FN = 'runScheduledFax';
var SCHEDULE_FOLDER_PROP = 'SCHEDULE_FOLDER_ID';
var SCHEDULE_MIN_AHEAD_MS = 60 * 1000;         // 直近すぎる予約は事故のもとなので1分は空ける
var SCHEDULE_MAX_AHEAD_DAYS = 30;              // 30日より先の予約は運用上想定しない
var SCHEDULE_MAX_TRIGGERS = 20;                // 時間主導トリガーの既定の上限（1スクリプトあたり）
var SCHEDULE_DONE_MAX_ROWS = 300;              // 「予約中」以外の行がこれを超えたら古い順に間引く

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index').setTitle('eFAX送信支援');
}

/* ---- 送信先マスタ ------------------------------------------------------ */

// 送信先マスタと送信履歴は同じスプレッドシートに、別シートとして持つ
function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('CLINIC_SHEET_ID');
  var ss;
  if (id) {
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (e) {
      // 一時的に開けないだけで新しいシートを作ると、登録済みの送信先が消えたように見えるので止める
      throw new Error('送信先マスタのスプレッドシートを開けませんでした。ファイルが削除されていないか確認してください。');
    }
  } else {
    ss = SpreadsheetApp.create('eFAX送信支援_送信先マスタ');
    props.setProperty('CLINIC_SHEET_ID', ss.getId());
    ss.getSheets()[0].setName(SHEET_NAME);
  }
  return ss;
}

function getSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getHistorySheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(HISTORY_SHEET_NAME) || ss.insertSheet(HISTORY_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HISTORY_HEADERS.length).setValues([HISTORY_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getScheduleSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SCHEDULE_SHEET_NAME) || ss.insertSheet(SCHEDULE_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SCHEDULE_HEADERS.length).setValues([SCHEDULE_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// 予約送信の待機中PDFを置くだけの専用フォルダ。送信先マスタのスプレッドシートと同じやり方で、
// 一度作ったフォルダのIDをスクリプトプロパティに覚えておく
function getScheduleFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(SCHEDULE_FOLDER_PROP);
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      throw new Error('予約送信の一時保存フォルダを開けませんでした。フォルダが削除されていないか確認してください。');
    }
  }
  var folder = DriveApp.createFolder('eFAX送信支援_予約送信一時ファイル');
  props.setProperty(SCHEDULE_FOLDER_PROP, folder.getId());
  return folder;
}

// 送信成功のたびに1行追記する。ここで失敗しても送信自体は済んでいるので、履歴の記録失敗は
// エラーにせず送信結果には影響させない（ログだけ残す）
function logSend_(name, fax, fileCount) {
  try {
    var sheet = getHistorySheet_();
    sheet.appendRow([new Date(), name, fax, fileCount, Session.getEffectiveUser().getEmail()]);
    // 増え続けないよう、上限を超えたら古い行から間引く
    var last = sheet.getLastRow();
    if (last - 1 > HISTORY_MAX_ROWS) sheet.deleteRows(2, last - 1 - HISTORY_MAX_ROWS);
  } catch (e) {
    console.error('送信履歴の記録に失敗しました: ' + e.message);
  }
}

// 直近の送信履歴を新しい順で返す
function getSendHistory(limit) {
  var sheet = getHistorySheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var n = Math.min(last - 1, Number(limit) || 200);
  var startRow = last - n + 1;
  var values = sheet.getRange(startRow, 1, n, HISTORY_HEADERS.length).getValues();
  var list = values.map(function (v) {
    return { at: v[0] instanceof Date ? v[0].getTime() : null, name: String(v[1] || ''),
      fax: String(v[2] || ''), files: Number(v[3]) || 0, by: String(v[4] || '') };
  });
  list.reverse();
  return list;
}

// 全角→半角・ダッシュ類→「-」だけを揃え、区切り方は打たれたまま残す（index.html の tidyFax と同じ規則）。
// ハイフンの位置は市外局番の桁数で決まり、数字だけからは正しく付けられないため推測しない
function tidyFax_(s) {
  return String(s == null ? '' : s)
    .replace(/[０-９（）]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[－ー‐―−–—]/g, '-')
    .replace(/(\d)[\s　]+(?=\d)/g, '$1-')
    .replace(/[^0-9()\-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 数値として保存された番号は先頭の0が失われているため、桁数から市外局番の0を補う
function faxDigits_(fax) {
  var digits = String(fax == null ? '' : fax).replace(/[^0-9]/g, '');
  if ((digits.length === 9 || digits.length === 10) && digits.charAt(0) !== '0') digits = '0' + digits;
  return digits;
}

function checkFaxDigits_(fax) {
  var digits = faxDigits_(fax);
  if (digits.charAt(0) !== '0' || digits.length < 10 || digits.length > 11) {
    throw new Error('FAX番号の形式が不正です（入力値: ' + fax + '）。市外局番の0から10〜11桁で入力してください。');
  }
  return digits;
}

function faxText_(cell) {
  return typeof cell === 'number' ? faxDigits_(cell) : String(cell || '').trim();
}

function pinValue_(cell) {
  return cell === true || String(cell).toUpperCase() === 'TRUE';
}

function readRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var list = [];
  values.forEach(function (v, i) {
    var name = String(v[0] || '').trim();
    if (!name) return;
    list.push({ row: i + 2, name: name, yomi: String(v[1] || '').trim(), fax: faxText_(v[2]), pin: pinValue_(v[3]) });
  });
  return list;
}

// 行番号だけを頼りに書くと、別の画面で行が消えた後に隣の医院を書き換えてしまう。
// 書く前に、その行の送信先名とFAX番号が画面で持っていた値と同じかを確かめる
function verifyRow_(sheet, row, expect) {
  row = Number(row);
  if (!(row >= 2) || row % 1 !== 0 || row > sheet.getLastRow() || !expect) throw new Error(STALE_MESSAGE);
  var v = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  if (String(v[0] || '').trim() !== String(expect.name || '').trim() ||
      faxDigits_(v[2]) !== faxDigits_(expect.fax)) {
    throw new Error(STALE_MESSAGE);
  }
  return v;
}

// 同時に2つの画面から書き込んでも、1件ずつ順番に処理する
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('ほかの保存が終わっていません。少し待ってから、もう一度操作してください。');
  try {
    var result = fn();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function getClinics() {
  return readRows_(getSheet_());
}

// input: { name, yomi, fax, row?, expect?: { name, fax } }  row があれば上書き、なければ末尾に追加
function saveClinic(input) {
  input = input || {};
  var name = String(input.name || '').trim();
  var yomi = String(input.yomi || '').trim();
  var fax = tidyFax_(input.fax);
  if (!name) throw new Error('送信先名を入力してください');
  checkFaxDigits_(fax);
  return withLock_(function () {
    var sheet = getSheet_();
    var row = sheet.getLastRow() + 1;
    var pin = false;
    if (input.row) {
      var current = verifyRow_(sheet, input.row, input.expect);
      row = Number(input.row);
      pin = pinValue_(current[3]);
    }
    // 文字列として保存する。FAX番号の先頭0が消えたり、「=」で始まる名前が数式になったりしないように
    sheet.getRange(row, 1, 1, 3).setNumberFormat('@');
    sheet.getRange(row, 1, 1, HEADERS.length).setValues([[name, yomi, fax, pin]]);
    return readRows_(sheet);
  });
}

// input: { row, name, fax }
function deleteClinic(input) {
  input = input || {};
  return withLock_(function () {
    var sheet = getSheet_();
    verifyRow_(sheet, input.row, input);
    sheet.deleteRow(Number(input.row));
    return readRows_(sheet);
  });
}

// input: { row, name, fax, pin }
function setPin(input) {
  input = input || {};
  return withLock_(function () {
    var sheet = getSheet_();
    verifyRow_(sheet, input.row, input);
    sheet.getRange(Number(input.row), 4).setValue(!!input.pin);
    return readRows_(sheet);
  });
}

/* ---- 送信 -------------------------------------------------------------- */

function buildEfaxAddress_(fax) {
  return '81' + checkFaxDigits_(fax).substring(1) + '@efaxsend.com';
}

// files: [{ name, base64 }] を検証してBlobの配列にする。即時送信(sendFaxNow_)と
// 予約作成(scheduleFax)の両方が使う共通チェック
function validateFiles_(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('送るPDFがありません');
  var totalBytes = 0;
  var blobs = files.map(function (f) {
    var name = String((f && f.name) || '');
    if (!/^[^\\\/:*?"<>|]{1,60}\.pdf$/.test(name)) throw new Error('添付ファイル名が不正です（' + name + '）');
    var bytes = Utilities.base64Decode(String(f.base64 || ''));
    // 先頭が %PDF でなければ、作成途中で壊れたデータとみなして送らない
    if (bytes.length < 5 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== '%PDF') {
      throw new Error(name + ' がPDFとして読めません。プレビューを作り直してください。');
    }
    totalBytes += bytes.length;
    return Utilities.newBlob(bytes, 'application/pdf', name);
  });
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error('添付の合計サイズが大きすぎます（' + Math.round(totalBytes / 1024 / 1024 * 10) / 10 +
      'MB）。別添のページを減らして送信してください。');
  }
  return blobs;
}

// payload: { fax, name, files: [{ name, base64 }] }
// files は index.html がプレビューの画像から作り直したPDF（送信票・別添1…）。元のファイルは届かない
// name は送信履歴に残す送信先名（表示用。省略しても送信自体は成立する）
function sendFax(payload) {
  return sendFaxNow_(payload || {});
}

// 即時送信ボタンと、予約送信が発火したとき（runScheduledFax）の両方がここを通る
function sendFaxNow_(payload) {
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (me !== EFAX_SENDER.toLowerCase()) {
    throw new Error('eFAXに登録した送信元（' + EFAX_SENDER + '）ではないアカウント（' + (me || '不明') +
      '）で動いているため、送信を止めました。' + EFAX_SENDER + ' でデプロイし直してください。');
  }
  var to = buildEfaxAddress_(payload.fax);
  var blobs = validateFiles_(payload.files);
  if (MailApp.getRemainingDailyQuota() < 1) {
    throw new Error('このアカウントの本日のメール送信数が上限に達しました。明日以降に送信してください。');
  }

  // Gmailの受信トレイ全体を読む権限を求めずに済むよう、送信専用の MailApp を使う
  MailApp.sendEmail(to, '{nocoverpage}', ' ', {
    attachments: blobs,
    name: PHARMACY_NAME
  });
  logSend_(String(payload.name || ''), payload.fax, payload.files.length);
  return { ok: true, to: to };
}

/* ---- 予約送信（時間指定） ------------------------------------------------ */
// GASにはサーバー常駐プロセスがないため、「予約」は送るPDFをDriveの専用フォルダへ置いたうえで、
// 指定時刻ちょうどに1回だけ発火する時間主導トリガーを作る方式で実現する。ブラウザを閉じていても、
// 指定時刻になればGoogle側がrunScheduledFaxを起こして送信する。

function deleteTriggerById_(uid) {
  if (!uid) return;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getUniqueId() === uid) {
      try { ScriptApp.deleteTrigger(t); } catch (e) { /* 発火後で既に消えている等 */ }
    }
  });
}

function deleteScheduleFiles_(fileIdsJson) {
  var ids;
  try { ids = JSON.parse(fileIdsJson || '[]'); } catch (e) { ids = []; }
  ids.forEach(function (id) {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* 既に削除済み等 */ }
  });
}

// 「予約中」以外（送信済み・エラー・キャンセル）の行が増えすぎないよう、古い順に間引く。
// 予約中の行は件数に関係なく必ず残す
function trimScheduleSheet_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return;
  var status = sheet.getRange(2, 8, last - 1, 1).getValues();
  var doneRows = [];
  for (var i = 0; i < status.length; i++) {
    if (status[i][0] !== SCHEDULE_STATUS.PENDING) doneRows.push(i + 2);
  }
  var excess = doneRows.length - SCHEDULE_DONE_MAX_ROWS;
  for (var j = 0; j < excess; j++) sheet.deleteRow(doneRows[j] - j);
}

// 予約中・処理済みをまとめて新しい予定順で返す。フロントは状態（status）で振り分けて表示する
function getScheduledFaxes() {
  var sheet = getScheduleSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, SCHEDULE_HEADERS.length).getValues();
  var list = values.map(function (v) {
    return {
      id: String(v[0] || ''),
      at: v[1] instanceof Date ? v[1].getTime() : null,
      name: String(v[2] || ''), fax: String(v[3] || ''), files: Number(v[4]) || 0,
      status: String(v[7] || ''), error: String(v[8] || '')
    };
  }).filter(function (r) { return r.id; });
  list.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
  return list;
}

// payload: { fax, name, files: [{ name, base64 }], sendAt: number|string }
// files・検証ルールは即時送信と共通（buildSendFiles(build)の出力をそのまま渡す想定）
function scheduleFax(payload) {
  payload = payload || {};
  checkFaxDigits_(payload.fax);
  var blobs = validateFiles_(payload.files);

  var sendAt = new Date(payload.sendAt);
  var now = Date.now();
  if (isNaN(sendAt.getTime())) throw new Error('送信予定日時が正しくありません。');
  if (sendAt.getTime() < now + SCHEDULE_MIN_AHEAD_MS) {
    throw new Error('送信予定時刻は、今より' + (SCHEDULE_MIN_AHEAD_MS / 60000) + '分以上あとにしてください。');
  }
  if (sendAt.getTime() > now + SCHEDULE_MAX_AHEAD_DAYS * 86400000) {
    throw new Error('予約できるのは' + SCHEDULE_MAX_AHEAD_DAYS + '日先までです。');
  }
  // 上限に達した状態でトリガーだけ作れず失敗すると、Driveにファイルだけ残ってしまう。
  // ファイルを作る前に必ず確認する
  if (ScriptApp.getProjectTriggers().length >= SCHEDULE_MAX_TRIGGERS) {
    throw new Error('予約できる件数の上限に達しています。既存の予約の送信・キャンセルを待ってから、もう一度お試しください。');
  }

  return withLock_(function () {
    var folder = getScheduleFolder_();
    var fileIds = blobs.map(function (b) { return folder.createFile(b).getId(); });
    var trigger = ScriptApp.newTrigger(SCHEDULE_TRIGGER_FN).timeBased().at(sendAt).create();

    var sheet = getScheduleSheet_();
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, SCHEDULE_HEADERS.length).setValues([[
      Utilities.getUuid(), sendAt, String(payload.name || ''), payload.fax, blobs.length,
      JSON.stringify(fileIds), trigger.getUniqueId(), SCHEDULE_STATUS.PENDING, '',
      Session.getEffectiveUser().getEmail()
    ]]);
    return getScheduledFaxes();
  });
}

// input: { id }
function cancelScheduledFax(input) {
  input = input || {};
  return withLock_(function () {
    var sheet = getScheduleSheet_();
    var last = sheet.getLastRow();
    var values = last < 2 ? [] : sheet.getRange(2, 1, last - 1, SCHEDULE_HEADERS.length).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]) !== String(input.id)) continue;
      if (values[i][7] !== SCHEDULE_STATUS.PENDING) {
        throw new Error('この予約はすでに処理されています。画面を読み込み直してください。');
      }
      deleteTriggerById_(values[i][6]);
      deleteScheduleFiles_(values[i][5]);
      sheet.getRange(i + 2, 8).setValue(SCHEDULE_STATUS.CANCELED);
      trimScheduleSheet_(sheet);
      return getScheduledFaxes();
    }
    throw new Error('予約が見つかりません。画面を読み込み直してください。');
  });
}

// 時間主導トリガーから呼ばれる。個々の予約ごとに専用の1回きりトリガーを作っているが、
// e.triggerUidの有無に頼り切らず「予約中」で予定時刻を過ぎている行をすべて処理する
// （トリガーのイベント情報が引けない場合や、実行が重なって取りこぼした場合の保険）
function runScheduledFax(e) {
  withLock_(function () {
    var sheet = getScheduleSheet_();
    var last = sheet.getLastRow();
    if (last < 2) return;
    var values = sheet.getRange(2, 1, last - 1, SCHEDULE_HEADERS.length).getValues();
    var now = Date.now();

    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v[7] !== SCHEDULE_STATUS.PENDING) continue;
      var at = v[1] instanceof Date ? v[1].getTime() : 0;
      if (at > now) continue;
      processScheduledRow_(sheet, i + 2, v);
    }
    trimScheduleSheet_(sheet);
  });
}

function processScheduledRow_(sheet, row, v) {
  deleteTriggerById_(v[6]);
  try {
    var fileIds = JSON.parse(v[5] || '[]');
    var files = fileIds.map(function (id) {
      var blob = DriveApp.getFileById(id).getBlob();
      return { name: blob.getName(), base64: Utilities.base64Encode(blob.getBytes()) };
    });
    sendFaxNow_({ fax: v[3], name: v[2], files: files });
    sheet.getRange(row, 8, 1, 2).setValues([[SCHEDULE_STATUS.SENT, '']]);
    deleteScheduleFiles_(v[5]);
  } catch (err) {
    sheet.getRange(row, 8, 1, 2).setValues([[SCHEDULE_STATUS.ERROR, String((err && err.message) || err)]]);
    notifyScheduleError_(v[2], v[3], err);
  }
}

// 予約送信はブラウザを閉じたあとにバックグラウンドで動くため、失敗しても画面に出せない。
// 気づけるよう、実行アカウント自身にだけ一報を送る
function notifyScheduleError_(name, fax, err) {
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      '【eFAX送信支援】予約送信に失敗しました',
      '送信先：' + (name || '(名称なし)') + '　FAX：' + fax + '\n' +
      'エラー：' + ((err && err.message) || err) + '\n\n' +
      'アプリの「予約一覧」から状況を確認してください。');
  } catch (e) {
    console.error('予約送信エラー通知に失敗しました: ' + e.message);
  }
}
