# YU-ZORA Service Status

YU-ZORA各ゲームが共通参照する公開ステータスです。漢字 de クラッシュキーボードのCloudflare matchmaking WorkerをGitHub Actionsから監視し、GitHub Pagesで `status.json` を配信します。

公開URL:

- `https://yuzora-yu.github.io/service-status/`
- `https://yuzora-yu.github.io/service-status/status.json`

## 監視仕様

- GitHub Actionsは毎時17分・47分（30分間隔）に `/health/deep` を確認します。
- probeには `Origin: https://yu-zora.com` を付け、本番CORSレスポンスも検証します。
- `/health/deep` はWorker本体だけでなく固定の監視用 `MatchRoom` Durable Objectまで到達確認します。実ルームは作成せず、ルームデータも書き込みません。
- Worker + CORS + Durable Objectが正常 → `operational`
- CORS不整合 → 即 `outage / cors_misconfigured`
- Durable Object異常 → 即 `outage / matchmaking_unavailable`
- 一般的なタイムアウト・通信失敗1回 → `degraded`
- 一般的な失敗2回連続 → `outage / unreachable`
- HTTP 429 または Cloudflare `Error 1027` → 即 `outage / daily_limit`
- `daily_limit` 確定後は翌09:05 JSTまでWorkerを再確認しません。
- 翌09:05以降も上限状態なら30分後に再確認します。

`lastCheckedAt` は実際にprobeした最新時刻、`updatedAt` は公開状態が最後に変化した時刻です。通常の正常チェックではGit commitを増やしませんが、GitHub Pagesには最新の `lastCheckedAt` を反映します。

## 漢字ゲームとの連携

漢字ゲーム側は次を参照します。

```js
serviceStatusUrl: "https://yuzora-yu.github.io/service-status/status.json",
serviceStatusKey: "cloudflare-matchmaking"
```

ゲーム側はステータス取得に失敗した場合はフェイルオープンし、実際のルーム作成・参加時にWorkerへ接続します。ゲーム自身が429/1027等を検知した場合は、その端末では即座に対戦を停止して再試行を抑制します。

## Actionの起動方法

- `schedule`: 30分間隔
- `workflow_dispatch`: GitHub UIから手動実行
- `repository_dispatch` (`matchmaking-alert`): 将来の信頼できる外部中継から即時再確認するためのフック

`repository_dispatch` をブラウザJavaScriptから直接呼ばないでください。GitHub tokenを公開クライアントへ置くとリポジトリ操作権限を悪用されるためです。即時通知を追加する場合は、Google Apps Script等の別系統の信頼できる中継を挟みます。

## サービス追加

将来別の共通サービスを追加する場合は `status.json` の `services` 配下に別キーを追加します。公開ゲームは `status.json` の読み取り専用クライアントとして扱います。
