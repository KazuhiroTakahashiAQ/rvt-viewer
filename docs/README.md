# ドキュメント

RVT ビューアの対応範囲、既知の問題、Revit ファイルの解析で確認した事実をまとめています。

- [既知の問題](known-issues.md)
- [解析でわかった事実](findings.md)

記載内容は、公開版のコミット `962bfca` と、同梱している rvt-rs のコミット `120e2f9`（`vendor/rvt-rs`）で確認したものです（2026-10-15 時点）。件数や時間は、下記「確認に使ったファイル」で実測した値です。

## 対応バージョン

| Revit のバージョン | 表示できるもの | 確認状況 |
| --- | --- | --- |
| 2024 / 2025 | 要素、形状、プロパティ、集計表、ファイル情報。形状を復元できない要素は Revit が保存した表示用メッシュで描画 | 確認済み（2024: 1 ファイル、2025: 3 ファイル） |
| 2026 | 2024 / 2025 と同じ（rvt-rs では実験的対応） | 確認済み（1 ファイル）。同じサンプルの 2025 版と要素数が一致 |
| 2023 | 要素（形状は主に境界ボックス。保存済み表示メッシュで描ける要素は置き換え）、プロパティ、ファイル情報 | 確認済み（1 ファイル） |
| 2016 〜 2022 | ファイル情報（メタデータ）のみ | 未確認（rvt-rs の記載による） |
| 2027 | 開けない（[既知の問題](known-issues.md#revit-2027-のファイルを開くとメモリが不足しましたと表示される)） | 確認済み（1 ファイル） |
| ファミリ（`.rfa`）・テンプレート（`.rte` / `.rft`） | ファイル情報のみ（ファミリ形状は未対応） | 未確認（rvt-rs の記載による） |

ブラウザは Chromium 系（Chrome / Edge）でのみ確認しています。

## 確認に使ったファイル

サンプル ファイルはリポジトリに含めていません。E2E テストは `RVT_SAMPLE` に下記のファイルを指定して実行しています（[README](../README.md#開発)）。

| ファイル | 版 | 要素数 | 保存済みメッシュで置換した要素（公開版） |
| --- | --- | ---: | ---: |
| `2024_Core_Interior.rvt` | 2024 | 970 | 138 / 138 |
| `Revit_IFC5_Einhoven.rvt` | 2023 | 37 | 11 / 11 |
| `racbasicsampleproject.rvt`（2025） | 2025 | 464 | 358 / 382 |
| `racbasicsampleproject.rvt`（2026） | 2026 | 464 | 372 / 396 |
| `racadvancedsampleproject.rvt`（2025） | 2025 | 5,657 | 5,104 / 5,183 |
| `rmebasicsampleproject.rvt`（2025） | 2025 | 6,754 | 5,639 / 6,023 |
| `racbasicsampleproject.rvt`（2027） | 2027 | 0 | 開けない |

「保存済みメッシュで置換した要素」は、rvt-rs が境界ボックス（または回転した箱）で出力した要素のうち、Revit がファイルに保存した表示用メッシュに置き換えられた数です（分母が対象数）。アプリでは「管理 → 読込診断」で同じ値を確認できます。

入手元:

- `2024_Core_Interior.rvt`、`Revit_IFC5_Einhoven.rvt`: [magnetar-io/revit-test-datasets](https://github.com/magnetar-io/revit-test-datasets)（MIT、コミット `fd755e18`）
- Autodesk のサンプル プロジェクト: `https://revit.downloads.autodesk.com/download/<版>RVT_RTM/Docs/InProd/<ファイル名>`（`<版>` は `2025` など）。SHA-256 は次のとおり（rvt-rs が参照用に記録している値と一致）。
  - 2025 `racbasicsampleproject.rvt`: `41f1893a62d974edbe19f6077f7b75d0b662fff8c6ed167576e7ff568d3d4293`
  - 2025 `racadvancedsampleproject.rvt`: `512e9188b245ba58fcc918630e4388b836df37042aa07de6db0e223b48de25d1`
  - 2025 `rmebasicsampleproject.rvt`: `037165e5d317667f3cc8b522b187b4a2025da5b8664ae3deb4ed0767180c8099`
  - 2026 `racbasicsampleproject.rvt`: `bc547fe94274a17abbea89330fcf8800b85652e0b8e25562b153c102af3d99dc`
  - 2027 `racbasicsampleproject.rvt`: `c9ce4d013b630028973e4549d3be4b38b3640641948b035680eeea7306491a01`
