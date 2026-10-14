# RVT ビューア

Revit ファイル (`.rvt` / `.rfa` / `.rte` / `.rft`) をブラウザだけで閲覧できる PWA です。
ファイルの解析には [rvt-rs](https://github.com/DrunkOnJava/rvt-rs)（Apache-2.0）を WebAssembly にビルドして使用しています。

**公開 URL: https://kazuhirotakahashiaq.github.io/rvt-viewer/**

- ファイルは端末内のブラウザで解析され、外部には送信されません（CSP で通信先を自オリジンに限定）。
- インストールするとオフラインでも動作し、OS から Revit ファイルを直接このアプリで開けます（Chromium 系ブラウザ）。
- 操作感は本家 Revit に寄せています。閲覧専用のため、編集コマンドやキーボード ショートカットはありません。

## 主な機能

- **Revit 風の画面構成**: ファイル メニュー、リボン（表示 / 管理 / 選択時の「修正 | カテゴリ」コンテキスト タブ）、クイック アクセス ツールバー、プロパティ パレット、プロジェクト ブラウザ、ビュー タブ、ビュー コントロール バー、ナビゲーション バー、ViewCube、ステータス バー
- **ビュー**: レベルごとの平面図（切断面の高さ・ビュー範囲の下端を指定可、切断面は塗りつぶし表示）、3D ビュー（平行投影 / 透視投影、切断ボックス）、東西南北の立面図、要素集計表、部屋集計表
- **表示スタイル**: ワイヤフレーム / 隠線処理 / シェーディング / 色の一貫性
- **選択**: クリック（Ctrl で追加、Shift で解除）、窓選択（左→右）、交差選択（右→左）、ホバー時のプリハイライトとツールチップ、選択フィルタ、すべてのインスタンスを選択
- **表示制御**: 表示/グラフィックスの上書き（カテゴリごとの表示・サーフェス色・透過性・ハーフトーン、レベル単位の表示/非表示、ビュー単位）、ビューで非表示、一時的に非表示/選択要素を分離、非表示要素を一時的に表示、選択ボックス
- **レベル（フロア）単位の操作**: プロジェクト ブラウザの平面図を右クリック → アクティブ ビューでこのレベルを非表示 / このレベルのみ表示 / すべてのレベルを表示、このレベルの要素を選択
- **プロパティ**: 識別情報・拘束・寸法（mm / m）・マテリアル/仕上げ（レイヤ構成）・関連要素（ホスト / 挿入要素 / 結合、クリックで移動）・IFC プロパティセット。複数選択時は共通値を表示
- **書き出し**: IFC4、glTF (GLB)、平面図 SVG、要素/部屋集計表 CSV、読込診断 JSON
- **その他**: ファイル情報（Revit バージョン、最終保存者・日時、ワークシェアリング等）、プロジェクト情報、読込診断、ライト / ダーク テーマ、最近使用したファイル（File System Access API 対応ブラウザ）

## マウス操作（Revit 準拠）

| 操作 | 内容 |
| --- | --- |
| ホイール | カーソル位置を中心にズーム |
| 中ボタン ドラッグ | パン |
| Shift + 中ボタン ドラッグ | オービット（選択要素 → カーソル下の点 → モデル中心を軸に回転） |
| 中ボタンのダブルクリック | 全体表示 |
| 左クリック | 選択（Ctrl+クリックで追加、Shift+クリックで解除、何もない所で解除） |
| 左ドラッグ（左→右 / 右→左） | 窓選択 / 交差選択 |
| 右クリック | コンテキスト メニュー |
| Esc | パン/オービット モードの終了、選択解除 |

トラックパッドの場合はナビゲーション バーの「パン」「オービット」を使うと左ドラッグで操作できます。タッチ操作では 1 本指でオービット（2D ビューではパン）、2 本指でパンとピンチ ズームです。

## 対応状況と制約

読み取れる内容は rvt-rs の対応範囲に依存します（rvt-rs README の「What does not work yet」を参照）。

- Revit 2024 / 2025 のプロジェクト: 要素と形状。
- Revit 2023: 要素（形状は境界ボックス。壁は結合部で切り詰め）。
- rvt-rs が形状を復元できない要素（ドア・窓・家具・植栽などのロード可能ファミリ）は、まず境界ボックスで表示し、読込後に Revit がファイルに保存した表示用メッシュに置き換えます（rvt-rs の `--saved-meshes` 相当）。置換中はステータス バーに「詳細形状を読込中…」と表示され、置換できた件数は「管理 → 読込診断」で確認できます。大きなファイルでは時間がかかるため、「ファイル → オプション」で無効にできます。保存済みメッシュがない要素は境界ボックスのままです。
  - rvt-rs 本体の置換に加えて、モデルの軸から回転して配置されたファミリ（rvt-rs が回転した箱で描くもの）と、RPC の樹木・人物・車など rvt-rs が読めない形式（`FacetedTopology8`）のメッシュも置き換えます。RPC は Revit の非レンダリング表示と同じ代替形状（樹木・人物はシルエット）で、写真のような見た目（RPC コンテンツ本体）はファイルに含まれないため表示できません。
- それ以前のバージョン: ファイル情報（メタデータ）のみ。
- ファミリ (`.rfa`): ファイル情報のみ（ファミリ形状は未対応）。
- 壁の開口は切り欠かれません。パラメータは一部のみ読み取れます。

## 開発

必要なもの: Rust (stable) + `wasm32-unknown-unknown` ターゲット、[wasm-pack](https://github.com/wasm-bindgen/wasm-pack)、Node.js 24 以上、pnpm。

```bash
git clone --recursive https://github.com/KazuhiroTakahashiAQ/rvt-viewer.git
cd rvt-viewer
rustup target add wasm32-unknown-unknown
pnpm install
pnpm run build:wasm   # wasm/（vendor/rvt-rs のバインディング）を src/wasm/pkg にビルド（初回は数分）
pnpm dev              # http://localhost:5173/rvt-viewer/
```

| コマンド | 内容 |
| --- | --- |
| `pnpm run build:wasm` | rvt-rs の WebAssembly をビルド |
| `pnpm dev` | 開発サーバー |
| `pnpm build` | 型チェック + 本番ビルド（`dist/`） |
| `pnpm test` | ユニット テスト（vitest） |
| `pnpm run test:e2e` | ブラウザ テスト（Playwright、本番ビルドが必要） |
| `pnpm run icons` | `public/favicon.svg` から PWA アイコンを生成 |

E2E テストで Revit ファイルを使う場合は、環境変数 `RVT_SAMPLE` にローカルのファイル パスを指定します（サンプル ファイルはリポジトリに含めていません）。

```bash
RVT_SAMPLE=/path/to/model.rvt pnpm run test:e2e
```

### rvt-rs の更新

rvt-rs は `vendor/rvt-rs` に git submodule として特定コミットで固定しています。

```bash
git -C vendor/rvt-rs fetch && git -C vendor/rvt-rs checkout <commit>
pnpm run build:wasm
```

### 構成

```
wasm/          rvt-rs の WebAssembly バインディング。rvt-rs 同梱の rvt-wasm のうち
               本アプリが使う関数と、rvt-wasm が公開していない保存済み表示メッシュの
               読み込み（attachSavedMeshes、拡張分は src/saved_meshes.rs）を公開する
src/
  worker/      rvt-rs (wasm) を実行する Web Worker と通信
  engine/      three.js による描画エンジン（要素のマージ描画、状態テクスチャ、
               BVH ピック、Revit 式ナビゲーション、ViewCube、切断ボックス）
  model/       モデル索引、カテゴリ対応、プロパティ、プロジェクト ブラウザ、単位
  state/       アプリ状態（zustand）
  ui/          React コンポーネント（リボン、パレット、ビュー、ダイアログ）
  i18n/        多言語化（i18next）
  pwa/         Service Worker 登録、ファイル ハンドラ、最近使用したファイル
```

## 多言語化

UI の文言はすべて `src/i18n/locales/ja.json` のキーで管理しています（現在は日本語のみ）。言語を追加するには:

1. `src/i18n/locales/<言語コード>.json` を `ja.json` と同じキー構成で作成
2. `src/i18n/index.ts` の `SUPPORTED_LANGUAGES` と `resources` に追加

ソース中で使われているキーが辞書に存在すること、コンポーネントに日本語がハードコードされていないことはユニット テストで検証しています。

## デプロイ

`main` への push で GitHub Actions（`.github/workflows/deploy.yml`）が wasm のビルド、型チェック、テスト、ビルドを行い GitHub Pages に公開します。

## ライセンス

Apache License 2.0（[LICENSE](LICENSE)）。同梱する rvt-rs の著作権表示は [NOTICE](NOTICE) を参照してください。

Autodesk および Revit は Autodesk, Inc. の登録商標です。本アプリは Autodesk, Inc. とは関係がなく、同社による承認・支援を受けたものではありません。
