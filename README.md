# YU-ZORA Service Status

YU-ZORA各ゲームが共通参照する公開ステータスです。漢字 de クラッシュキーボードのCloudflare matchmaking WorkerをGitHub Actionsから監視し、GitHub Pagesで `status.json` を配信します。

公開URL（Pages有効化後）:

- `https://yuzora-yu.github.io/service-status/`
- `https://yuzora-yu.github.io/service-status/status.json`

## 監視仕様

- GitHub Actionsが5分ごとに `/health` を1回確認します。
- `200` かつ `{ "ok": true }` → `operational`
- 一般的な失敗1〜2回 → `degraded`
- 一般的な失敗3回連続 → `outage`
- HTTP 429 または Cloudflare `Error 1027` → `outage / daily_limit`
- `daily_limit` 確定後は翌09:05 JSTまでWorkerを再確認しません。上限到達後の無駄なリクエストを防ぎます。
- 翌09:05以降も1027なら10分後に再確認します。
- 正常状態が続いているだけなら `status.json` を毎回書き換えず、不要なコミット・Pagesデプロイを発生させません。

## 漢字ゲームとの連携

漢字ゲーム側は次を参照します。

```js
serviceStatusUrl: "https://yuzora-yu.github.io/service-status/status.json",
serviceStatusKey: "cloudflare-matchmaking"
```

ゲーム側はステータス取得に失敗した場合はフェイルオープンし、実際のルーム作成・参加時にWorkerへ接続します。

## 初回実行

Actionsの `Check matchmaking status` を `Run workflow` で1回手動実行します。初回の `workflow_dispatch` は状態変化の有無に関係なくGitHub Pagesをデプロイします。その後は5分間隔のscheduleが継続します。

## サービス追加

将来別の共通サービスを追加する場合は `status.json` の `services` 配下に別キーを追加します。ゲーム側にGitHub書き込み用トークンを持たせないでください。公開ゲームは `status.json` の読み取り専用クライアントとして扱います。
