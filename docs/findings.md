# 解析でわかった事実

本アプリの開発中に、rvt-rs（本家のコミット `120e2f9`、および修正を重ねた fork のコミット `d92d1d5`）を使って Revit ファイルを解析して確認した事実です。フィールド名は rvt-rs がファイル内のスキーマから読み出した名前です。数値は [確認に使ったファイル](README.md#確認に使ったファイル) での実測値です。推測を含むものは「推測」と明記しています。

## ファミリの定義は .rvt に含まれる

Revit 標準ライブラリのファミリでも、プロジェクトにロードした時点で定義（タイプ、形状、パラメータ）がプロジェクト ファイルにコピーされます。外部のライブラリ ファイルは参照していません。

ファイル内の表示用データ（後述の保存済みグラフィックス）では次のように表れます。

- インスタンスの保存済みグラフィックスは `GElement → GInstance → InstanceInfo` で、`InstanceInfo` が配置（`m_Trf`: 3×3 行列 `m_3x3` と原点 `m_or`）と、描画するファミリ タイプの ElementId（`m_symbolId`）を持つ。
- ファミリ タイプのレコードが共有の形状（シンボル）を持ち、そのタイプのすべてのインスタンスがこれを描く。

例: `racbasicsampleproject.rvt`（2025）の樹木 `RPC Tree - Deciduous : Honey Locust - 25'`（ElementId 946385）は、ファミリ タイプ 946006 を参照します。946006 のグラフィックスには次が含まれます。

- `GElement`: 範囲 X −9.18 〜 9.85、Y −8.93 〜 11.05、Z 0 〜 25 ft
- `GImposter`: RPC コンテンツへの参照（`m_oAsset` → `Asset`）
- `GPolyMesh` → `FacetedTopology8`: 頂点 693、三角形 689 の代替メッシュ
- `GLine` / `GArc`: 平面図用の記号線
- `APropertyString` などのアセット プロパティ

## RPC（樹木・人物・車）

- RPC ファミリの写真のような見た目（ArchVision の RPC コンテンツ本体）はファイルに含まれず、アセットへの参照（`GImposter`）だけが保存されている。
- Revit が通常の表示で描く代替形状は `GPolyMesh` として保存されている。位相は `FacetedTopology8` で、`FacetedTopology0` と同じ点（`m_pointsArr`）と三角形（`m_facetsArr`）に加えて、面ごとの法線（`m_normalsArr`、`m_normalsFlag` = 2）と辺の表示フラグ（`m_edgeVisFlagsArr`）を持つ。
- rvt-rs は `FacetedTopology0` だけを読み、`FacetedTopology8` は `unsupported faceted topology` で捨てる。`GImposter` も `unsupported reachable graphics class GImposter` として扱う。
- `racbasicsampleproject.rvt`（2025）の RPC 21 要素（樹木 16、人物 4、車 1）はすべてこの形式で、19 要素は回転して配置されている。代替形状は、樹木と人物がシルエットの平面、車が立体のメッシュ。

## 保存済みグラフィックス（表示用データ）の構造

Revit は要素ごとに最後に描画したグラフィックスをファイルに保存しています。rvt-rs の `native_document` ではチャネル 103 のレコードで、オブジェクトのグラフ（`ObjectGraph`）として読めます。主なクラスとフィールド:

| クラス | 主なフィールド | 内容 |
| --- | --- | --- |
| `GElement` | `m_subNodes`, `m_bBox`, `m_elementId` | 要素（またはシンボル）のルート |
| `GGroup` / `GFilter` | `m_subNodes`, `m_oConditions` | グループと表示条件。条件は `GConditionDir`（視線方向）、`GConditionInt`（詳細レベルなど）、`GConditionCut` |
| `GInstance` | `m_instanceInfo`, `m_oEmbeddedSymbolGRep`, `m_forbiddenTarget`, `m_bHasScale`, `m_resolveSymInView` | 入れ子のファミリやシンボルの配置 |
| `InstanceInfo` | `m_Trf`, `m_symbolId`, `m_GRepId` | 配置行列と参照するシンボル |
| `Geometry` | `m_pFaces` | B-rep のソリッド |
| `Face` | `m_pSurf`, `m_pFirstLoop`, `m_faceFlags_v9`, `m_faceRegions`, `m_renderStyleId`, `m_GInfo.m_tag` | 面。`m_faceFlags_v9` のビット 2 は面の向きが曲面の向きと逆であることを示す |
| `EdgeLoop` / `EdgeLoopWithChainEnvelopes` | `m_next`, `m_nextLoop`, `m_pFace`, `m_open` | 面の境界ループ |
| `Edge` | `m_pFace`（2）, `m_next`（2）, `m_prev`（2）, `m_firstAndLastEdgePnts`, `m_interiorEdgePnts` | 辺。両側の面それぞれのパラメータ座標（`uv`）で点列を持つ |
| `GPolyMesh` | `m_pFacetedTopology`, `m_materialID`, `m_interiorGStyleID` | 三角形メッシュ |
| `GBiFlipControl` | `m_base`, `m_length`, `m_origin` | 手摺などの反転コントロール（矢印）。面を持たない |

辺について:

- 辺の点は両側の面のパラメータ座標（UV）だけで、3D 座標は保存されていない。3D 位置は面の曲面を評価して求める必要がある。
- 曲線の辺の点は粗い。例: `rmebasicsampleproject.rvt` の配管継手では 90° の円弧が 3 点（両端と中間 1 点）。点をそのままつなぐと配管の断面が八角形になるため、曲面上で細分化する必要がある。

### 曲面と曲線の定義

| クラス | フィールド | 点の式 |
| --- | --- | --- |
| `Plane` | `m_origin`, `m_xVec`, `m_yVec` | `origin + u·x + v·y` |
| `CylSurf` | `m_center`, `m_radius`, `m_xVec`, `m_yVec`, `m_zVec` | `center + r·(cos u·x + sin u·y) + v·z` |
| `ConeSurf` | `m_center`, `m_halfAngle`, `m_xVec`, `m_yVec`, `m_zVec` | `center + v·(cos α·z + sin α·(cos u·x + sin u·y))`（α = `m_halfAngle`） |
| `RuledSurf` | `m_pProfileCurve1`, `m_pProfileCurve2`, `m_Point1`, `m_Point2` | `(1 − v)·A(u) + v·B(u)` |
| `SurfRev` | `m_center`, `m_xVec`, `m_yVec`, `m_zVec`, `m_pProfileCurve` | 輪郭曲線を z 軸まわりに u だけ回転 |

- `ConeSurf` の `m_center` は円錐の頂点で、v は頂点から母線に沿った距離（推測。次の値で確認）。`rmebasicsampleproject.rvt` の配管継手で、端の辺 v = 0.22857 ft、α = 0.2170 rad から半径 v·sin α = 0.0492 ft となり、隣の平面側の円の半径 0.04921 ft と一致する。v·cos α = 0.2232 ft も、頂点から平面までの距離と一致する。
- `RuledSurf` の A・B は輪郭曲線を u ∈ [0, 1] で曲線のパラメータ範囲に対応させたもの（rvt-rs と同じ解釈）。輪郭曲線のポインタが null のときはその側が点（`m_Point1` / `m_Point2`）になる。ダクト継手の先細り部分がこの形で、rvt-rs は `missing surface pointer target` で読めない。
- `CylSurf` の座標系は右手系とは限らない（x × y = −z のものがある）。rvt-rs は左手系を `left-handed cylinder basis` で拒否する。
- 曲線: `GLine`（`m_origin`, `m_dirVec`, `m_endParams`）、`GArc`（`m_center`, `m_xVec`, `m_yVec`, `m_radius`, `m_endParams`）、`GEllipse`（`m_center`, `m_xVec`, `m_yVec`, `m_xLen`, `m_yLen`, `m_endParams`）、`GHermiteSpline`（`m_NodeArray` の各要素が `m_iParametr`, `m_iPoint`, `m_iTangent`。接線はパラメータに対する微分で、隣接点の差と一致する）。rvt-rs は `GLine` と `GArc` だけを読む。

## rvt-rs が保存済みグラフィックスを読めない箇所

rvt-rs（`native_saved_mesh`）は平面と、長方形のトリムを持つ円柱面・回転面・線織面だけを三角形化します。1 つの面で失敗すると、その面を含む `Geometry` 全体を捨てます。曲面に接する平面は、隣の曲面に合わせて辺を細分化するときに曲面側を読むため、曲面が読めないと平面も失敗します。

曲面に対応する前の公開版（コミット `962bfca`）で箱のまま残った要素の面を、rvt-rs で 1 面ずつ読んだ結果（重複する面は 1 回）:

| ファイル | 読めた面 | 読めなかった面（主な原因） |
| --- | --- | --- |
| rmebasic | 平面 305、円柱 46 | 円錐 200、長方形でないトリムの円柱 176（巻き添えの平面 92）、輪郭が null の線織面 72（巻き添えの平面 90）、複数ループの円柱 40（同 32）、左手系の円柱 28（同 10） |
| racadvanced | 平面 2,250、円柱 30 | 長方形でないトリムの円柱 96（巻き添えの平面 128）、エルミート スプライン輪郭の線織面 6（同 8） |
| racbasic | 平面 306、回転面 16、円柱 2 | 左手系の円柱 52（同 36）、長方形でないトリムの円柱 47（同 18）、円錐 28、長方形でないトリムの線織面 28（同 22）、曲がった輪郭の線織面 23、楕円輪郭の線織面 6 |

走査（`native_graphics_traversal`）で要素ごと捨てられるもの:

- ルートの `GInstance` に `m_forbiddenTarget.m_targets` = 10 を持つ家具 60 要素（racadvanced）。rvt-rs は 0 以外を `instance target restrictions are unsupported` として拒否する。値の意味は不明（推測: 表示以外の用途の制限。これらの家具は Revit の 3D ビューで表示される配置家具）。
- `GBiFlipControl` を含む手摺 9 要素（racadvanced）。

## 曲面を自前で三角形化してわかったこと

rvt-rs が読めない面は、本アプリの wasm crate（`wasm/src/brep.rs`）で、面の曲面を評価して UV 平面上で三角形分割し、曲がり具合に応じて細分化しています。その過程で確認したこと:

- 隣り合う辺の端点の UV が一致しないことがある。racadvanced では最大で約 4×10⁻⁵ ずれていた（Revit の許容誤差内の隙間）。1×10⁻⁷ で一致を判定すると、1,200 面以上でループがつながらない。
- 極（円錐の頂点、ドームの頂上、点に収束する線織面の端）では、隣り合う辺が 3D では同じ点で接するが、UV の u が異なる（π や 1 だけずれる）。ループはその特異な線に沿って進む。
- 円柱面・円錐面・回転面の u は周期 2π、輪郭が閉曲線（または点）の線織面の u は周期 1。同じ面のループや辺の点が 1 周期ずれていることがある。
- 辺の 3D 位置を曲がっている側の面で求めると、反対側の面の UV（両端の間を補間したもの）で評価した位置とわずかにずれる。細分化の誤差判定は、その面自身の曲面上の値どうしで比べる必要がある（そうしないと分割が収束しない）。
- 細分化は最も長い辺から行う必要がある。任意の順で分割すると、細長い三角形の短い辺だけが分割され続けて収束しない。
- 面の向きは ∂S/∂u × ∂S/∂v を、曲面の `m_orientFlag` と面の `m_faceFlags_v9` のビット 2 の排他的論理和で反転したもの、として扱っている（平面と右手系の円柱では rvt-rs と同じ。それ以外は推測）。glTF は両面で書き出されるため、表示への影響はない。
- ビューアの稜線は、隣り合う三角形の法線が 25° 以上違う所に引かれる。曲面の分割を 1 区間 25° 未満（約 23°）にしないと、曲面上の分割線がすべて稜線として描かれる。

## rvt-rs の出力（IFC モデル）について

要素の形状の出どころは、メインのプロパティ セット `RvtElementRecordGeometry` の `BodySource` に入ります。

| `BodySource` | 意味 |
| --- | --- |
| `partition_element_record_bbox` | 要素レコードの境界ボックス。`ProfileResolved` が true のときは箱がそのまま正しい形（柱・床など） |
| `partition_family_instance_turned_box` | モデルの軸から回転したファミリ インスタンス。回転した長方形で、境界ボックスと同程度の近似 |
| `partition_family_instance_oriented_box` | 回転・傾斜したカーテンパネル・マリオン |
| `saved_graphics_mesh` | 保存済み表示メッシュで置き換えた形状 |

- 同じ ElementId を複数のエンティティが持つことがある（分割して出力される床など）。
- RPC や植栽・添景は `IfcBuildingElementProxy` で出力され、Revit のカテゴリは渡されない。

glTF（`model_to_glb`）について:

- ルート ノードが Z-up・フィート → Y-up・メートルの変換を持ち、要素ごとのノードの `extras.entityIndex` がモデルのエンティティ番号。
- 要素の配置は `location_feet` と、Z 軸まわりの `rotation_radians` による回転。
- 三角形の面集合（`TriangulatedFaceSet`）は両面で書き出される（各三角形の後に、逆向きの三角形を同じ順で追加）。三角形の順序は保たれる。法線は書き出さない。
- 層構成（RE-53）を持つ要素は、形状が押し出しのときだけ層ごとのノードに分けて層の色で書き出される。保存済みメッシュで面集合に置き換えると 1 つのノードになり、要素のマテリアル（なければカテゴリ）の色になる。

## マテリアル

- 面ごとのマテリアルはチャネル 102 のレコードにあり、rvt-rs の `native_saved_materials::Resolver` が、要素・シンボル・面のタグ・レンダリング スタイル・マテリアル ID から解決する。
- 既定のビューポート設定（`default_viewport_profile`）では色のアルファを 1 に固定し、保存されている不透明度は `saved_opacity` に残る。
- 保存済み表示メッシュを読めた要素のうち、不透明度が 1 未満の面を含む要素: Core Interior 6、Einhoven 2、racbasic 11、racadvanced 41、rmebasic 215。
- マテリアルの解決はインスタンスごとで、同じファミリ タイプでも解決できるインスタンスとできないインスタンスがある。Core Interior の窓ガラスは青（0, 0, 255）・不透明度 0.25 に解決される。racbasic の窓ガラスは、どのインスタンスでも解決できない。
- 解決された色が Revit の表示と一致するかは確認できていない。racbasic の屋根（`SG Metal Panels roof`）の一部の面は赤（174, 0, 0）に解決される。このため本アプリでは、透明な面を含む要素にだけ面ごとの色を使っている。
- glTF の面集合は両面（逆向きの三角形つき）で書き出され、ビューアのマテリアルも両面描画のため、透明な面をそのまま描くと 2 回重ねて塗られる。透明な面は片側の三角形だけを使う必要がある。
- 面の塗装（ペイント、`m_pGeomTable` の `GeomMaterialMarker`）を持つレコードは、確認した 5 ファイルでは壁（`SWall`）と床（`Floor`）だけ（Snowdon Towers: 壁 109、床 5）。ファミリ インスタンスとシンボルにはない。
- マテリアルの解決に要るのは、マテリアル（`MaterialElem`）、外観アセット（`AppearanceAssetElem`）、オブジェクト スタイル（`GStyleElem`）、壁・床のタイプ（`BasicWallType`、`FloorAttributes`）と、描く要素・シンボル自身のレコード。チャネル 102 のレコードをすべて読む（Snowdon Towers で 47,181 件、ネイティブで約 7 秒）代わりに、これらのクラスだけ（4,186 件、約 0.4 秒）と描く要素のレコードを読んでも、確認した 6 ファイルで結果は同じだった。

## ElemTable（ElementId の一覧）の 2 つの ID 欄

`Global/ElemTable` は、ファイル内のすべての ElementId を並べた一覧です。Revit 2024 以降の 1 件は 40 バイトで、`[u64 ID 1][12 バイト][u64 ID 2][u64 所有者][u32]` の形をしています。

- ほとんどのファイルでは ID 1 と ID 2 は同じ値。番号が付け直された要素では ID 1 に古い ID が残り、ID 2 が現在の ElementId になる（rvt-rs の RE-41 と同じ解釈）。一覧は ID 2 の昇順に並んでいる。
- 利用者提供の Revit 2026 プロジェクト（158 MB、build 20250630）では、102,324 件のうち 8,698 件で ID 1 と ID 2 が異なり、ID 1 で見ると 169 か所で昇順が崩れる。ID 2 は全体で厳密に昇順。
- 要素レコード（パーティションのレコード連鎖）の ElementId は、121,152 件中 121,132 件が ID 2 に一致する（ID 1 に一致するのは 109,546 件）。
- 件数は 65,536 を超えることがある（このファイルは 102,324 件）。rvt-rs のヘッダー構造体の `record_count` は下位 16 bit だけを持つ。
- 本家 rvt-rs は、一覧の形式（1 件 28 バイトか 40 バイトか）を「ID 1 が全体で昇順か」で判定している。このファイルでは判定に失敗して 12 バイトの予備の解釈に切り替わり、ID の一覧が壊れる（7,982 件しか残らない）。その結果、壁 2,250・ドア 264・窓 340 などの要素レコード 13,922 件がすべて「ElementId を特定できない」（RE-30）として捨てられ、要素 0 件になっていた。

## 32 bit の WebAssembly でだけ起きる不具合

WebAssembly（wasm32）では `usize` が 32 bit のため、ファイル内の `u32` の長さを足す計算が桁あふれし、範囲の確認をすり抜けて範囲外を読む。64 bit のネイティブ実行では起きない。見つかった 2 か所:

- `walker.rs` の文字列の読み取り: `4 + 文字数 × 2`。Revit 2027 の `racbasicsampleproject.rvt` がパニックし、ファイル情報も表示できなかった。
- `partition_room_parameters.rs` のデータ オブジェクトの走査: `位置 + 16 + サイズ`。利用者提供の Revit 2026 プロジェクトがパニックした。

## fork での rvt-rs の修正

本家 rvt-rs（`120e2f9`）に、次の修正を重ねた fork（[KazuhiroTakahashiAQ/rvt-rs](https://github.com/KazuhiroTakahashiAQ/rvt-rs) の `rvt-viewer` ブランチ、コミット `d92d1d5`）を使っています。

- `elem_table::detect_layout`: ID 1 と ID 2 のどちらかが全体で昇順なら、その形式を採用する。利用者提供の Revit 2026 プロジェクトは要素 0 件から 7,922 件（レベル 30）になり、rvt-rs の信頼度は最高（`geometry`、未出力 0 件）になった。他の確認用ファイルの要素数は変わらない。
- `partition_room_parameters::data_objects`: 末尾位置の計算を飽和加算にする。
- `walker::read_field_by_type`: 文字列の長さの加算を桁あふれ検査付きにする。Revit 2027 のファイルが、ファイル情報のみのモデル（要素 0 件）として開けるようになった。
- `compression::InflatedStream`: 各 gzip メンバーの CRC-32 を初めて照合するときに計算して保持し、パーティションを走査するたびに計算し直さない（[固定費](#保存済みメッシュを少しずつ読むときの固定費)）。照合の内容は変わらない。要素の解析の時間は変わらない（ネイティブで約 7.5 秒）。

## メモリ

### 保存済みメッシュの処理で何がメモリを使うか

Autodesk の `Snowdon Towers Sample Architectural.rvt`（Revit 2024、90 MB、6,103 要素）での計測（ネイティブ実行）:

- 要素の解析: 約 8 秒、最大約 1.9 GB。
- 保存済みメッシュの対象は 3,555 要素（置換 3,422、約 722 万三角形）。照明器具 447 要素で約 299 万、家具 345 要素で約 126 万三角形。
- rvt-rs は保存グラフィックスを `serde_json::Value` のオブジェクト グラフとして読む。対象要素の 3,555 グラフと、それらが描くシンボルの 3,525 グラフを JSON 文字列にすると約 100 MB と約 204 MB だが、メモリ上では約 2.9 GB になる（一度にすべて読むと処理全体のピークは約 4.7 〜 5.5 GB）。
- 置換後のモデルを JSON にすると約 407 MB、glTF（GLB）は約 237 MB。以前はこのモデルを Worker と wasm の間、Worker とページの間で JavaScript オブジェクトとして何度も受け渡していた。

対象要素を何件ずつ読むか（ファミリ・タイプ順に並べて分割し、1 回ごとにグラフを破棄）での比較:

| 1 回に読む要素 | 処理時間 | ピーク メモリ（解析分を含む） |
| ---: | ---: | ---: |
| すべて | 16 秒 | 4.7 GB |
| 1,000 | 23 秒 | 2.9 GB |
| 400 | 31 秒 | 2.5 GB |
| 200 | 47 秒 | 2.3 GB |

1 回ごとに文書全体の保存グラフィックスを走査するため、回数が増えるほど遅くなる（この表は下記の固定費を減らす前の値）。

### 保存済みメッシュを少しずつ読むときの固定費

rvt-rs の `native_document::extract` で選んだ要素のレコードを読むと、1 回ごとに次の固定費がかかる（Snowdon Towers、ネイティブ実行。WebAssembly では数倍）。

- パラメータ定義の読み込み: `extract` は毎回、文書中のパラメータ定義をすべて読み直す（約 1 秒）。保存グラフィックスの読み取りには定義が要らないため、定義を読まない `extract_graphs` を使うと 1 件でも約 0.15 秒になる。
- パーティションの走査: 選んだ要素がどのパーティションにあるかを調べるため、毎回すべてのパーティションを 2 回走査する。そのたびに、展開済みのパーティションの各 gzip メンバーの CRC-32 を計算し直していた（約 0.1 秒。CRC-32 は WebAssembly では特に遅い）。fork では CRC-32 をメンバーごとに 1 回だけ計算して保持し、約 0.05 秒になった（8 件の読み込みが約 0.15 秒 → 約 0.05 秒）。
- 対象要素とシンボルが入れ子になっているため、1 回の読み込みはシンボルの段数だけ繰り返す（多くは 1 〜 2 回）。

以前の版は、マテリアルの解決のためにチャネル 102 のレコードもすべて読んでいた（約 7 秒、[マテリアル](#マテリアル)）。これらをやめた結果、500 件ずつ読んでも Snowdon Towers の読み込みは 31 〜 40 秒から約 19 秒になった（一度にすべて読む以前の方法の 16 秒とほぼ同じ）。本アプリは、画面に映っている要素から先に描くため、24 件から始めて倍々に増やしながら読む。

### その他

- rvt-rs の解析は多くのメモリを使う。`rmebasicsampleproject.rvt`（32 MB）は、ネイティブ実行で最大約 2.9 GB（保存済みメッシュの読み込みを含む。曲面対応前の公開版でも約 2.85 GB）。
- 利用者提供の Revit 2026 プロジェクト（158 MB）は、要素の解析だけでネイティブ実行で最大約 2.0 GB。保存済みメッシュの対象は 6,646 要素・約 1,094 万三角形で、うち照明器具 1,040 要素が約 753 万三角形（1 要素あたり約 7,200）を占める。

## バージョンごとの挙動

- Revit 2026 の `racbasicsampleproject.rvt`（初期版 build 20250227）は、2025 版と同じ 464 要素を読める。保存済み表示メッシュの置換は 396 / 396。
- Revit 2026 の更新版（build 20250630）のファイルは、要素を読めるがレベル名は復元されない（「Elevation -4.593 ft」のような標高表示になる）。初期版のサンプルではレベル名が出る。
- Revit 2027 の `racbasicsampleproject.rvt` は、要素 0 件のファイル情報のみのモデルとして開ける（rvt-rs が 2027 の要素に未対応）。
