# 场景查询：几何首交点 + 实时光照（V2）

镜头模式（B）不再查询任何屏幕颜色/深度图。每条通过真实镜组的出射光线：

```
像素/口径/波长采样 → 反向追迹真实镜组 → 世界射线
  → SceneIntersector：两级 BVH 求最近有效交点（真实注册几何）
  → SurfaceRadianceEvaluator：在该交点重建表面属性、按材质和灯光着色
  → （有界）透明层沿同一射线继续
  → 既有 RGB→光谱→XYZ 与 f32 累计
```

光栅只负责：纯光栅导航视图、太阳/月亮/灯具阴影贴图、PMREM 环境、水面平面反射，以及最终显示。镜头 compute 在同一 `GPUDevice` 上直接读取这些纹理，不经 CPU。

这不是完整路径追踪：没有场景多次漫反射、没有通用 GI、没有镜内鬼影或波动衍射成像；DOE 仅按指定阶次的相位梯度进行几何追迹。

## 模块

| 模块 | 作用 |
| --- | --- |
| `src/scene/lens-registry.js` | 显式注册：天空/月亮/星空为环境对象（不作遮挡几何）；程序材质描述符。不按名称猜测。 |
| `src/scene/procedural-params.js` | 木纹、草地色变、枯山水耙纹、水面的唯一常量来源；TSL 光栅图与生成的 WGSL 常量都读它。 |
| `src/scene/scene-extract.js` | 场景 → 类型化数组（复制属性，不 detach Three 的几何）：每个 (geometry, group, drawRange) 一个 BLAS 源；每个 Mesh/实例一条实例记录；材质分类与不支持原因。 |
| `src/scene/bvh-builder.js` | 分箱 SAH（16 bins，三轴），f64 构建、f32 向外取整的保守包围盒；BLAS 叶 ≤4 三角形，TLAS 叶恰好 1 个实例；打包 GPU 缓冲。 |
| `src/scene/bvh-worker.js` | 在 Worker 中构建，按 key 缓存 BLAS 与源数据，实例变化只重建 TLAS。 |
| `src/scene/scene-reference.js` | 仅测试用的 f64 暴力求交和打包 BVH 的 JS 遍历仿真。不是运行时后备。 |
| `src/rendering/scene-intersector.wgsl` | 可移植 compute 两级遍历（不假定硬件 rayQuery / RT Core）。 |
| `src/rendering/scene-shading.wgsl` | 材质、灯光、阴影、PMREM、天空/月亮/星空、雾、水面、透明合成。 |
| `src/rendering/scene-resources.js` | BVH/材质表 GPU 生命周期、限额检查、变化检测。 |
| `src/rendering/lighting-resources.js` | 唯一接触 Three 阴影/PMREM/反射渲染目标的桥接模块；版本与格式检查；灯光 uniform。 |

## BVH 组织与数值

* **实例化**：同一几何的所有实例共享一个 BLAS；草叶、树叶、针叶、木板等不展开为重复三角形。TLAS 以每实例的世界 AABB 构建（含 4e-6×|坐标| 的填充，覆盖 f32 世界→物体矩阵的舍入），叶节点只含一个实例，所以密集植被不会出现一个叶子挂海量实例；完全重合的实例按数量对半分，深度仍受控。引用顶点不超过 64 个的小网格（草叶、树叶等植被）的世界 AABB 由**变换后的顶点**精确求得，而不是局部包围盒 8 个角点的包围盒：旋转的薄片实例盒子收紧后 TLAS 重叠明显减少（实测每条光线进入的实例数约减少 23%，盒子测试约减少 6%），结果不变。大网格仍用角点法。
* **节点**：32 字节 `{lo, a, hi, b}`；叶子 `b = 0x80000000 | count`。TLAS 在前，BLAS 依次追加，索引已重定位。实例记录 128 字节：前 64 字节为遍历所需的世界→物体 3 行与 info（BLAS 根、材质、标志、源记录），后 64 字节为着色所需的 positionLocal 框架与实例色。
* **SAH 分箱**：默认 16 箱；图元数 ≥ 4096 的节点用 32 箱（只影响树顶部少数节点，构建时间增加很少，盒子测试约减少 4%）。
* **变换**：射线用存储的 3×4 世界→物体矩阵变换到实例局部，**不归一化**局部方向，因此 t 在世界和局部空间含义相同。法线用 `(W2O)ᵀ n`（逆转置）。正面判定 `dot(局部几何法线, 局部方向) < 0` 与世界空间判定恒等，对负缩放同样成立（测试覆盖）。注：Three 光栅对 InstancedMesh 只按 `matrixWorld` 的行列式翻转卷绕，实例矩阵为负行列式时其光栅剔除与本实现不同；当前场景实例的负行列式数量经提取统计为 0。
* **最近交点**：遍历按子节点入口距离近先远后，并在出栈时剔除入口距离 > 当前最近 t 的节点；绝不在首个交点处提前返回。
* **两个遍历变体**：`scene-intersector.wgsl` 中的遍历是模板，由 `scene-wgsl.js` 展开两次：方向分量都非零的光线（几乎全部）走只含普通 slab 测试的快速变体；任一分量恰好为 0 的光线（轴对齐诊断光线）走保留封闭 slab 平行处理的精确变体，实例变换后出现零分量时也会改走精确变体重新查询。两者对各自覆盖的光线逐位给出相同结果；平行处理原本让每次盒子测试的指令数近乎翻倍。
* **三角形**：watertight 射线三角形求交（Woop, Benthin, Wald, JCGT 2013，独立实现），共享边不漏；包围盒出口 t 乘 `1+2γ₃`（Ize 2013）。
* **数值保护**：方向分量 |d|<1e-30 替换为 ±1e-30 以避免 0·∞；非有限输入射线、栈溢出（栈 64，构建时验证 TLAS 深度 + 最大 BLAS 深度 ≤ 64）、节点/实例/三角形越界、叶子计数异常、访问节点超过 1,048,576 次，都返回 `BVH_TRAVERSAL_ERROR`，绝不当作背景。运行时只要该错误率 > 0 就停止累计并显示。
* **剔除规则**：FrontSide 只接受正面，BackSide 只接受背面，DoubleSide 两面都接受；背面命中的着色法线按 Three 的 `directionToFaceDirection` 翻转。

## 状态

| 代码 | 名称 | 含义 |
| --- | --- | --- |
| 1 | OPTICAL_BLOCKED | 镜组物理遮挡：零贡献，计入尝试，跳过场景求交 |
| 2 | OPTICAL_TIR | 全反射：同上 |
| 3 | OPTICAL_NUMERICAL_ERROR | 镜组数值失败 |
| 4 | SCENE_HIT | 真实表面（可能经过透明层） |
| 5 | SCENE_BACKGROUND | 无表面：解析环境（天空、太阳盘、星、月） |
| 7 | SCENE_UNSUPPORTED | 命中未支持材质：贡献 0 并计数，不涂成灰色 |
| 8 | BVH_TRAVERSAL_ERROR | 实现/数值错误（见上） |
| 9 | TRANSPARENCY_LIMIT | 同一射线超过 6 个透明层：贡献 0 并计数，不用任意背景补色 |

另计：无效辐亮度（NaN/负值）、水面反射查找落在参考视野外（近似诊断）、穿过的透明层数。

## 材质（显式注册，覆盖当前场景）

当前场景经提取：443 个 Mesh、264,078 个实例、279 个 BLAS、103,879 个基础三角形（展开后 3,399,513）、127 种材质；全部为 `MeshStandardNodeMaterial`，另有 1 个 `MeshPhysicalNodeMaterial`（水）。53 个非索引几何、0 个多材质 groups、0 个负行列式、19 个顶点色材质、33 个实例色 InstancedMesh；**没有任何图片纹理、alphaTest 或 alpha 卡片**——叶片与草叶都是真实几何，保持原样。

支持：基础色 × 顶点色（`vertexColors` 且几何有 color）× 实例色；自发光（color×intensity，含 HDR）；metalness/roughness（`max(0.0525)`）；Physical 的 ior/specular 与 clearcoat；FrontSide/BackSide/DoubleSide；透明混合（Normal blending）。

程序材质：

* **木纹**（`woodMat`）：在 `positionLocal`（InstancedMesh 为实例矩阵后的坐标，与 Three 的 InstanceNode 一致）上求 MaterialX Perlin 噪声、纹理颜色与粗糙度。光栅用屏幕导数（dFdx/dFdy）做表面梯度凹凸；compute 改为在交点求高度场的空间梯度：颗粒项解析求导，噪声项用噪声晶格单位 h = 1/1024 的中心差分（截断误差 ~1e-6），再按局部→世界的逆转置变换到世界并投影到表面：`N' = normalize(N − (g − N(N·g)))`，与 Mikkelsen 表面梯度公式等价。单位：高度为米。
* **草地色变**：`noise(positionWorld × (2.5,1,2.5)) × 0.065 + 0.95`，再乘以大尺度枯黄斑块 `mix(1, patchTint, smoothstep(-0.05, 0.45, noise(positionWorld × patchScale)) × 0.55)`。
* **枯山水耙纹**（`applyRakedGravel`，`PROCEDURAL.GRAVEL`）：在 `positionWorld` 上取耙纹坐标 u——落在任一石块的环带内时为到该石块的有符号距离（同心环），否则为世界 z（平行直纹）；高度 = depth × (sin(2πu/spacing)·½+½)，沟槽按同一项压暗，并乘以 MaterialX 噪声颗粒色。compute 对高度解析求梯度（∇u 为离开石心的单位向量或 +z），再按上式投影法线。光栅预览把窄于约一个像素的沟槽淡化为平均值以避免摩尔纹；镜头路径不做淡化，逐样本求出真实沟槽，分辨率、摩尔纹与焦外过渡完全由镜头积分给出。
* **水面**：程序波纹 → 切线空间法线（平面 uv=(x,−z)，T=+x，B=−z）；clearcoat；自发光 = 平面反射纹理 × Fresnel(wo) × 2.2；不透明度 0.35。

MaterialX 噪声逐行移植（哈希、梯度、fade、trilerp、0.982 缩放），光栅/compute 对照误差 ~0.1%。未支持特性（非 Standard/Physical 类型、图片纹理、alphaTest/alphaHash、transmission/sheen/iridescence/anisotropy、非 Normal 混合、flatShading/wireframe、没有描述符的自定义节点）在提取报告和 UI 中列出。

纹理过滤：场景没有图片纹理，因此不存在 albedo mip 选择问题。compute 中只对 PMREM（按粗糙度选 cubeUV 层，与 Three 相同）、平面反射（level 0，与光栅相同，反射目标无 mip）使用显式 `textureSampleLevel`。不把散景直径当作纹理 footprint。程序纹理在每条路径的真实交点处点采样，像素内与口径上的多次采样自然完成积分。

## 用户模型

庭院面板“自定义模型”载入 `.glb`（或 `.gltf` 连同 `.bin`/纹理），也可拖入窗口；文件只在本机读取。可载入多个模型（同批文件横向排开），列表中逐个移除；所有用户模型共享 150 万三角形的细分预算。`src/scene/model-import.js` 把加载器材质重建为 `MeshStandard/PhysicalNodeMaterial`，使光栅与镜头走同一套已支持材质：

* **颜色贴图 → 顶点色**：按 UV 双线性采样（遵循 wrap、flipY、纹理变换与 sRGB→线性）。网格先做均匀 1→4 中点细分，使中位三角形边长约 4 texel（最多 4 级，总预算 150 万三角形），共享中点保持水密。细节受顶点密度限制，比原贴图柔和。
* **取平均**：粗糙度/金属度贴图（glTF G/B 通道）与自发光贴图乘入常量因子。
* **忽略并报告**：法线/AO/透明度等其余贴图、alpha 裁剪、透射/光泽/虹彩、骨骼与形变（按绑定姿态）、模型自带灯光与相机、点/线。报告见状态行悬停提示。
* **不支持**：Draco 与 KTX2 压缩（给出明确错误）；Meshopt 支持。
* **放置**：尺寸在 0.05–60 m 时按 glTF 米制原样保留，否则缩放到 2 m；水平居中于视线中心（环视目标），底部落在其正下方的表面上。投射/接收阴影，并加入灯具阴影层。

* **场景内操作**：单击模型选中（黄色包围盒）；左键拖动沿地表移动（底部贴合下方表面，模型之间不叠放）；滚轮以底面中心缩放（总尺寸限制 0.02–200 m）；Shift + 滚轮绕竖直轴旋转；Delete 移除，Esc 或单击空白处取消选中。未命中模型时，鼠标照常控制相机。监听器注册在画布的捕获阶段，先于相机控制。缩放与旋转都保持最低点高度不变，因此拖动时无需遍历顶点。

场景刷新会检测新增与移除的网格并重建 TLAS；拖动松手或滚轮停顿 350 ms 后提交一次（BVH 重建串行），阴影贴图通过重新应用当前时刻刷新。拖动过程中镜头图像保持旧场景，直到提交。

## 光照

* **直接光**：方向光（太阳、月亮）与点光源，Three r183 `PhysicalLightingModel` 的 Lambert + GGX（Smith 相关可见性、Schlick Fresnel、多重散射补偿、DFG LUT 逐值复制）；点光距离衰减与截止同 `getDistanceAttenuation`。默认不发场景阴影射线。
* **阴影**：读取 Three 生成的阴影贴图。方向光：`light.shadow.matrix`（WebGPU z∈[0,1]），`normalBias` 沿着色法线偏移，`y → 1−y`，`z + bias`，视锥外为 1；PCFSoft 9 项公式在 compute 中写成等价的 4×4 可分离加权和（权重 1−f,1,1,f），同一比较采样器（less-equal，线性）。点光：立方体深度纹理（`CubeDepthTexture`，6 层），WebGPU 下方向 y 取反，`viewZToPerspectiveDepth + bias`，5 点 Vogel 盘；光栅用屏幕交错梯度噪声旋转，镜头路径用每样本无状态哈希旋转。启用阴影但有接收体时贴图缺失 → 显式错误，不静默变成无阴影。灯光 layers：点光阴影相机只渲染第 1 层（别墅、细节），由光栅决定，compute 只读结果。
* **环境**：半球光 irradiance + PMREM（cubeUV 布局逐行移植，非普通 cubemap）的镜面 radiance 与 `π×` irradiance，漫反射/镜面分别按 Three 的公式拆分，不重复叠加。方向相关项用真实交点法线和实际 wo。
* **AO**：GTAO 只用于光栅导航。镜头模式没有等价 AO，环境项不乘屏幕 AO（差异：凹角与接触处镜头图像的间接光比光栅亮）。不为此增加射线。
* **几何粗糙度**：Three 用屏幕空间法线导数增加粗糙度（`getGeometryRoughness`），compute 路径没有像素导数，不实现；弯曲金属面的高光与光栅存在差异（对照测试：曲面金属球中位误差 6%，平面金属板 < 2%）。
* **雾**：FogExp2 按真实路径长度 t 计算（光栅用视深）；光轴上相同，离轴略强。天空/星/月不加雾，与原材质一致。
* **天空/太阳/月亮/星空**：注册为环境对象。天空按射线方向求原天空着色公式（含云噪声、太阳盘）；光栅天空是以原点为心、半径 230 m 的球，存在极小视差。月亮为解析球（原相机跟随网格，含月相、月海噪声、地平线不透明度）。星空：1100 颗星按方向栅格查找，每颗为固定角半径 4.6×10⁻⁴ rad 的圆盘，亮度等于光栅精灵值（光栅星是屏幕空间 1.25 px 精灵，没有物理角尺寸；该半径为 1080 px 高、40° 参考视野下的等面积值）。静止累计期间灯光/天空参数只在光照 revision 时写入，累计中不会漂移。

## 透明与水面

透明混合表面（水、玻璃、锦鲤鳍、竹水流、涟漪）沿**同一射线**由前到后合成：`L += T·a·C；T *= 1−a`，下一层 tMin = t + 1e-4 + 2e-6·t（排除同一表面及共享边上的重复）。最多 6 层，超限为 `TRANSPARENCY_LIMIT`。不模拟折射（水下物体位置为直线视线）。水面反射为**参考视点平面反射近似**：用主相机投影交点取反射纹理（与光栅相同的 `screenUV.flipX` + 波纹偏移），交点在主相机视野外时 clamp 采样并单独计数；它不是正确的反射光线追踪。

## 积分核与分阶段

镜头路径统一使用 `staged`，所有适配器都执行镜头批次 → 精简求交 → 着色三个阶段。求交阶段只包含 BVH 遍历，写出 32 字节首交点记录；着色阶段从记录出发合成，透明层继续沿同一射线求交。阶段生成代码位于 `src/rendering/staged-integrator.js`。

针孔、独立采样及显式四路重追迹保留为诊断参考，用 `tests/mirror-reuse-gpu.html` 检查镜像复用、分块与累计结果；它们不参与正式渲染路径选择。工作计数使用相同的三个阶段，按需编译。

样本包按**正象限的 8×8 像素块**编号，一个 warp 覆盖 8×4 像素。`staged` 的暂存：光学样本包最多 64 MiB，另有每个包槽 16 条交点记录（约 171 MiB）；块数超过暂存时自动分块。

## 调度与失效

| 变化 | 镜头侧动作 |
| --- | --- |
| 几何拓扑 | 只重建该几何 BLAS + TLAS（Worker） |
| 物体/实例变换、实例色、可见性 | 只重建 TLAS；BLAS 复用（主线程不再复制已缓存几何属性） |
| 材质参数 | 只重写材质表 |
| 灯光/时间 | 光栅刷新阴影/PMREM（daylight 已做）；镜头侧刷新灯光 uniform、材质表（自发光强度），清空累计；不动 BVH |
| 相机姿态 | 一次资源刷新渲染（16×11 目标，像素不被读取；用于反射目标/姿态），清空累计；不动 BVH |
| 镜头/对焦/光圈 | 只更新光学 uniform 并清空累计 |
| 曝光、Bloom、HDR/SDR | 只重新显示 |

静止累计时每批只提交镜头/首交点/着色 compute 和显示。AF-S 沿当前镜头参考主光线求 BVH 交点，规则：第一个**不透明**表面；透明层被穿过并计数；背景 → ∞；BVH 错误或透明层超限 → 失败且不改焦点；结果带 geometry/optics/camera revision，过期结果丢弃。

## 已移除

旧的单层 RGB/深度屏幕查询（`scene-radiance.wgsl`、`raster-cache.js`、`scene-query-reference.js` 及其测试）已删除，不保留为隐式后备；镜头 WGSL 中不存在屏幕颜色/深度纹理绑定。
