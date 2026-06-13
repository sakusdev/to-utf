# 2utf Legacy Web Reader

日本のレガシーWebを、ブラウザとAIの両方が扱いやすいUTF-8 / Markdownへ変換するCloudflare Workerです。

単純なShift_JIS変換だけでなく、文字コード宣言が間違っているページ、古いHTML、ルビ、定義リスト、複雑な表などを、できるだけ情報を落とさず変換します。

## 使い方

### UTF-8 HTML

従来どおり、変換したページをブラウザで表示します。

```text
https://2utf.sakus.org/?url=https%3A%2F%2Fexample.jp%2Fold.html
```

### Markdown

```text
https://2utf.sakus.org/?url=https%3A%2F%2Fexample.jp%2Fold.html&format=markdown
```

`format=md`も使用できます。

### JSON + 出典ブロック

```text
https://2utf.sakus.org/?url=https%3A%2F%2Fexample.jp%2Fold.html&format=json
```

JSONにはMarkdown本文に加えて、次の情報が含まれます。

- 最終取得URLと元サーバーのHTTPステータス
- 検出した文字コード、宣言された文字コード、判定信頼度
- 実際に適用された抽出モードと警告
- 見出し・段落・リスト・表ごとのCSS風セレクタ
- 元HTML内のおおよその文字オフセット
- 表の二次元配列、結合セルの有無

## 抽出モード

```text
&mode=complete
```

ページ上の可視情報を極力残す標準モードです。

```text
&mode=article
```

本文候補をスコアリングして抽出します。高い信頼度で本文を特定できない場合は、情報を黙って捨てず`complete`へフォールバックし、警告を返します。

```text
&mode=raw
```

未知のHTML要素も可能な範囲でインラインHTMLとして残す、最小加工モードです。

## 対応内容

- UTF-8
- Shift_JIS / Windows-31J / CP932
- EUC-JP
- ISO-2022-JP
- HTTPヘッダーと`meta charset`の不一致補正
- `<ruby>` → `漢字（かんじ）`
- `<dl><dt><dd>`の保持
- 相対リンクと画像URLの絶対URL化
- 入れ子リスト、引用、コードブロック
- iframe / frameset内の参照先リンク
- 単純な表のMarkdown表化
- `rowspan` / `colspan`を含む複雑な表のHTML保持
- JSON出力時の表グリッド化
- 同じ入力から同じ出力を作るルールベース変換

JavaScript実行後にしか本文が生成されないページのブラウザレンダリング、PDF解析、OCRはまだ行いません。

## レスポンスヘッダー

```text
X-2utf-Version
X-2utf-Source
X-2utf-Original-Encoding
X-2utf-Charset-Confidence
X-2utf-Extraction-Mode
```

Markdown / JSON変換が成功した場合、元サイトが404などを返していても変換結果自体はHTTP 200で返します。元のステータスはJSONの`source.status`へ記録されます。

## ローカル実行

```bash
npm install
npm run dev
```

テスト:

```bash
npm test
```

デプロイ:

```bash
npm run deploy
```

## Cloudflare Dashboardからデプロイ

1. **Workers & Pages**を開く
2. **Import a repository**を選ぶ
3. GitHubの`sakusdev/to-utf`を接続する
4. デプロイコマンドを`npm run deploy`にする
5. **Settings → Domains & Routes**で`2utf.sakus.org`を追加する

## セキュリティ

- `http` / `https`以外を拒否
- URL内の認証情報を拒否
- 80 / 443番以外のポートを拒否
- URLに直接書かれたプライベートIPv4 / IPv6を拒否
- リダイレクト先も再検査
- テキスト本文を2 MiBに制限
- Cookieや認証ヘッダーを転送しない

任意URL取得サービスにはSSRFや帯域乱用のリスクがあります。公開運用ではCloudflare側のレート制限も設定してください。DNS名が後からプライベートIPへ解決されるDNS rebindingをWorkerのJavaScriptだけで完全に防ぐことは困難です。高い安全性が必要な用途では取得先ドメインを許可リスト方式にしてください。
