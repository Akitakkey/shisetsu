# shisetsu リポジトリ概要

このリポジトリには、経緯は関連するが**コード・データともに独立した3つのアプリ**が
入っている。

## 1. 施設訪問記録（リポジトリ直下）

`index.html` 1ファイル（+ `manifest.json`, アイコン類）で完結する静的PWA。
薬剤師が施設訪問時にSOAP形式（S/O/A/EP）の訪問記録をAIで生成するためのツール。

- ビルド不要・依存ライブラリ無し。ブラウザで`index.html`を開くだけで動く。
- 状態は全て`localStorage`（`shisetsu_*`キー）に保存。バックエンドDBは無い。
- 記録生成はClaude/Gemini APIを直接ブラウザから呼ぶ（APIキーはユーザーが
  設定画面で入力し`localStorage`に保存）。
- Slack送信のみ、CORS回避のためGAS（Google Apps Script）製プロキシ
  （`callProxy()`、`localStorage`の`shisetsu_proxy_url`で設定）を経由する。
  Slack Bot TokenはGAS側のScript Propertiesで管理し、ブラウザ側には持たせない。
- 算定点数は「基本点数（342点＝介護／320点＝医療）＋加算（麻薬・麻薬持続・TPN）」の
  組み合わせで管理（`BASE_POINTS` / `KASAN_DEFS`）。
- 外部スケジュールアプリとの連携は**現状なし**。画面上部の「📅カレンダー」は
  自作の日付ピッカー（`showCalendarPicker()`）で、Googleカレンダー等の外部連携では
  ない。訪問日はあくまで「どの日の記録を編集するか」を選ぶローカルなUI状態。

## 2. schedule-app/（訪問スケジュール GASアプリ）

Googleカレンダーをバックエンドにした、薬剤師の日次訪問スケジュールボード
（Google Apps Script Webアプリ）。詳細・データモデル・進行中の一時機能は
`schedule-app/CLAUDE.md` を参照。

**重要**：このリポジトリの静的PWA（上記1）と`schedule-app/`は、会話のきっかけは
同じでも実装上はまだ**繋がっていない**。「施設訪問記録から訪問スケジュールを
参照する／書き込む」といった統合は議論止まりで未実装。今後そういう依頼が来たら
両方のデータモデルを踏まえた設計が必要になる。

## 3. efax-app/（eFAX送信支援 GASアプリ）

「つなぐ薬局足立」が連携先の医院へFAXを送るための、Google Apps Script Webアプリ
（eFAXのメールtoFAXゲートウェイ経由）。上記1・2とはコードもデータも独立している。
詳細・データモデル・予約送信（時間指定して後で送る機能）の設計は`efax-app/CLAUDE.md`
を参照。
