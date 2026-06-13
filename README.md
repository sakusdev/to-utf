# to-utf

Shift_JIS / Windows-31Jなどで配信される古いWebページを取得し、UTF-8へ変換して返すCloudflare Workerです。

## 使い方

```text
https://utf8convert.sakus.org/?url=https%3A%2F%2Fexample.com%2Fpage.html
```

直接パス形式にも対応しています。

```text
https://utf8convert.sakus.org/https://example.com/page.html
```

URLにクエリ文字列や`#`が含まれる場合は、`?url=`形式を推奨します。

## ローカル実行

```bash
npm install
npm run dev
```

## Cloudflare Workersへデプロイ

Cloudflare Dashboardで次の手順を行います。

1. **Workers & Pages** を開く
2. **Create application** または **Import a repository** を選ぶ
3. GitHubの `sakusdev/to-utf` を接続する
4. デプロイコマンドを `npm run deploy` にする

CLIから直接デプロイする場合:

```bash
npm install
npx wrangler login
npm run deploy
```

独自ドメインは、Worker作成後に **Settings → Domains & Routes** から `utf8convert.sakus.org` を追加してください。

## 主な仕様

- `Content-Type`またはHTML内の`meta charset`から文字コードを判定
- 文字コード指定がない場合はShift_JISとして処理
- HTML内のcharset宣言をUTF-8へ書き換え
- 相対URL解決用の`<base>`を挿入
- HTMLリンクを変換プロキシ経由へ簡易書き換え
- 画像・PDFなどのバイナリは変換せずそのまま転送
- 本文サイズ上限は2 MiB
- `localhost`、プライベートIP、80/443以外のポートを拒否
- リダイレクト先も再検査

## 注意

公開URL取得サービスはSSRFや帯域乱用の標的になり得ます。Cloudflare側でもレート制限を設定してください。また、DNS名が後からプライベートIPへ解決されるDNS rebindingをWorkerのJavaScriptだけで完全に防ぐことは困難です。高い安全性が必要なら、取得可能ドメインの許可リスト方式に変更してください。
