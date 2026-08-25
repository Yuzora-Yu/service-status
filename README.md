# YU-ZORA Service Status

YU-ZORA各ゲームが共通参照する公開ステータスです。Cloudflare上のオンライン対戦WorkerをGitHub Actionsから外部監視し、GitHub Pagesで `status.json` を配信します。

公開URL:

- `https://yuzora-yu.github.io/service-status/`
- `https://yuzora-yu.github.io/service-status/status.json`

## 監視対象

- `cloudflare-matchmaking`: 漢字でクラッシュ！キーボードのフレンド対戦
- `yubi-strategy-online`: 指スト道場のオンライン組手

ゲームごとに別キーを持つため、片方だけのCORS設定不良などで他ゲームまで巻き添え停止しません。

## 監視仕様

- GitHub Actionsは毎時01分・31分（30分間隔）に各 `/health/deep` を確認します。
- probeには `Origin: https://yu-zora.com` を付け、本番CORSレスポンスも検証します。
- `/health/deep` はWorker本体だけでなくDurable Objectまで到達確認します。監視用IDを使い、実際の対戦ルームや待機列は作成しません。
- Worker + CORS + Durable Objectが正常 → `operational`
- CORS不整合 → 即 `outage / cors_misconfigured`
- Durable Object異常 → 即 `outage / durable_object_unavailable`
- 一般的なタイムアウト・通信失敗1回 → `degraded`
- 一般的な失敗2回連続 → `outage / unreachable`
- HTTP 429 または Cloudflare `Error 1027` → 即 `outage / daily_limit`
- `daily_limit` 確定後は翌09:01 JSTまでWorkerを再確認しません。
- 翌09:01以降も上限状態なら30分後に再確認します。

`lastCheckedAt` は実際にprobeした最新時刻、`updatedAt` は公開状態が最後に変化した時刻です。通常の正常チェックではGit commitを増やしませんが、GitHub Pagesには最新の `lastCheckedAt` を反映します。

`status.json` はworkflow自身のpushトリガー対象から除外しています。Actionが状態変更をcommitしても、監視Actionがもう1本再帰的に起動して余計なWorker probeを行うことはありません。

## ゲームとの連携

漢字ゲーム:

```js
serviceStatusUrl: "https://yuzora-yu.github.io/service-status/status.json",
serviceStatusKey: "cloudflare-matchmaking"
```

指スト道場:

```js
serviceStatusUrl: "https://yuzora-yu.github.io/service-status/status.json",
serviceStatusKey: "yubi-strategy-online"
```

ゲーム側はステータス取得に失敗した場合はフェイルオープンします。通常のトップページ表示ではゲームのWorkerへ接続せず、ルーム作成・参加、またはユーザーがオンラインモードを選んだ後の保存セッション再接続時に初めてWorkerへ接続します。ゲーム自身が429/1027等を検知した場合は、その端末では即座に対戦を停止して再試行を抑制します。指スト道場の自動マッチングは負荷確認が終わるまでゲーム側スイッチで休止し、フレンド対戦のみ中央ステータスに従って利用可能にします。

## Actionの起動方法

- `schedule`: 毎時01分・31分
- `workflow_dispatch`: GitHub UIから手動実行
- `repository_dispatch` (`matchmaking-alert`): 将来の信頼できる外部中継から即時再確認するためのフック

`repository_dispatch` をブラウザJavaScriptから直接呼ばないでください。GitHub tokenを公開クライアントへ置くとリポジトリ操作権限を悪用されるためです。即時通知を追加する場合は、Google Apps Script等の別系統の信頼できる中継を挟みます。
