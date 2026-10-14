# 解析でわかった事実

本アプリの開発中に、rvt-rs（`vendor/rvt-rs`、コミット `120e2f9`）を使って Revit ファイルを解析して確認した事実です。フィールド名は rvt-rs がファイル内のスキーマから読み出した名前です。数値は [確認に使ったファイル](README.md#確認に使ったファイル) での実測値です。推測を含むものは「推測」と明記しています。

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

## マテリアル

- 面ごとのマテリアルはチャネル 102 のレコードにあり、rvt-rs の `native_saved_materials::Resolver` が、要素・シンボル・面のタグ・レンダリング スタイル・マテリアル ID から解決する。
- 既定のビューポート設定（`default_viewport_profile`）では色のアルファを 1 に固定し、保存されている不透明度は `saved_opacity` に残る。
- 保存済み表示メッシュを読めた要素のうち、不透明度が 1 未満の面を含む要素: Core Interior 6、Einhoven 2、racbasic 11、racadvanced 41、rmebasic 215。
- マテリアルの解決はインスタンスごとで、同じファミリ タイプでも解決できるインスタンスとできないインスタンスがある。Core Interior の窓ガラスは青（0, 0, 255）・不透明度 0.25 に解決される。racbasic の窓ガラスは、どのインスタンスでも解決できない。
- 解決された色が Revit の表示と一致するかは確認できていない。racbasic の屋根（`SG Metal Panels roof`）の一部の面は赤（174, 0, 0）に解決される。このため本アプリでは、透明な面を含む要素にだけ面ごとの色を使っている。
- glTF の面集合は両面（逆向きの三角形つき）で書き出され、ビューアのマテリアルも両面描画のため、透明な面をそのまま描くと 2 回重ねて塗られる。透明な面は片側の三角形だけを使う必要がある。

## メモリ

- rvt-rs の解析は多くのメモリを使う。`rmebasicsampleproject.rvt`（32 MB）は、ネイティブ実行で最大約 2.9 GB（保存済みメッシュの読み込みを含む。曲面対応前の公開版でも約 2.85 GB）。

## バージョンごとの挙動

- Revit 2026 の `racbasicsampleproject.rvt` は、2025 版と同じ 464 要素を読める。保存済み表示メッシュの置換は 372 / 396。
- Revit 2027 の `racbasicsampleproject.rvt` は、ネイティブ（64 bit）では要素 0 件として開ける。WebAssembly（32 bit）では `walker.rs:688` で UTF-16 文字列の長さの計算が桁あふれしてパニックする（[既知の問題](known-issues.md#revit-2027-のファイルを開くとメモリが不足しましたと表示される)）。
