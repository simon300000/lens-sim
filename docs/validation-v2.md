# V2 验收记录：几何首交点 + 实时光照

日期 2026-10-15。本地实现，未 push、未部署。核心实现、集成与验收由 Codex 负责；UI 由本机 Claude Code（claude-opus-5-5）按 [UI 交接](ui-handoff.md) 修改，见下文。

## 运行环境（实际）

* 容器内 Linux，无物理 GPU。Chromium 141（Playwright headless shell）+ **SwiftShader WebGPU 适配器（软件实现，CPU 执行）**，`timestamp-query` 可用，`maxTextureDimension2D` = 8192，`maxStorageBufferBindingSize` = `maxBufferSize` = 1 GiB，`maxStorageBuffersPerShaderStage` = 10。
* 需要的启动参数（无头环境下 WebGPU canvas 呈现必须）：`--enable-unsafe-webgpu --enable-features=Vulkan,WebGPUService --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --disable-vulkan-surface --use-angle=swiftshader --ignore-gpu-blocklist --disable-gpu-watchdog`。未加这些参数时连原有、未修改的 `/tests/hdr-gpu.html` 也会在 canvas 呈现时 device lost；这是该无头环境的限制，与本次改动无关。
* **所有耗时都是 SwiftShader 的 CPU 仿真耗时，不代表任何硬件 GPU；本次没有在 NVIDIA/AMD/Intel/Apple GPU、Firefox 或 Safari 上验证。** V1 记录中的 RTX/Chrome 数据未在本次重测。

运行方式：

```sh
npm test                                   # Node：122 项（含 BVH f64 对照与整座别墅构建）
node scripts/run-gpu-tests.mjs             # 浏览器 WebGPU 验收页，结果写入 artifacts/
node scripts/app-smoke.mjs --spp 64 --ev 3 # 完整应用：别墅、镜头模式、AF、诊断视图、截图
```

## 当前场景清单（提取器实际统计）

443 个可见 Mesh，264,078 个实例，279 个 BLAS（每个 geometry×range 一个），103,879 个基础三角形，展开后 3,399,513 个三角形，127 种材质（126 MeshStandardNodeMaterial + 1 MeshPhysicalNodeMaterial 水）。53 个非索引几何，0 个多材质 groups，0 个负行列式实例，19 个顶点色材质，33 个实例色 InstancedMesh；无图片纹理、无 alphaTest、无 alpha 卡片（叶片与草叶都是真实几何）。注册的环境对象 3 个（天空球、月亮、星空 Points）。真实材质下未支持材质数 **0**。灯：2 个方向光（日、月，PCFSoft 阴影 3072²/2048²），4 个点光（2 个立方体阴影 512²，阴影相机只看第 1 层），1 个半球光，PMREM（64 面尺寸），水面平面反射（主画布 × 0.45）。

BVH：588,546 节点（TLAS 528,155 / BLAS 60,391），TLAS 深度 29，最大 BLAS 深度 16，栈上界 45 ≤ 64，TLAS 每叶 1 实例；GPU 常驻 62.5 MB（节点 18.8 MB、实例 33.8 MB、三角形 6.6 MB、顶点 3.2 MB、材质/星表）。

## 测试结果

### Node（`npm test`）

全部通过。新增 `tests/scene-bvh.test.mjs`：f32 向外取整、SAH 叶覆盖与包围、重合实例分裂、提取（环境角色、隐藏对象、groups、drawRange、负行列式）、**打包 BVH 的 JS 遍历 vs f64 暴力求交**（最近 t、实例、原 primitive、重心、正反面；3000 条射线，含轴向/近平行方向）、遮挡物后隐藏表面、FrontSide/BackSide 剔除、t 参数在非均匀缩放下保持、材质分类、整座别墅提取 + 构建（Node 单线程约 2.3 s）。

### A. GPU BVH vs f64 参考（`/tests/scene-bvh-gpu.html`）

18,108 条射线（全球面方向、指向随机实例包围盒的射线、近平行与零分量方向，另有 3,521 条“越过第一交点后继续”的隐藏表面查询）。命中 9,629；重心最小值 > 1e-4 的 9,624 个稳健命中 **实例、原 primitive、正反面全部一致**；最大相对 t 误差 9.0e-6，最大重心误差 5.5e-5；无漏检、无误检、无遍历错误。BVH 在 Worker 中构建。

### B. 首交点与隐藏背景（`/tests/hidden-surface-gpu.html`）

只用自发光/吸收几何（无灯），镜头 Canon FL 50mm，240×160：

| 项 | 结果 |
| --- | --- |
| 细杆正后方 1 cm 品红条纹，中心针孔视点 | 0（被完全遮挡） |
| 同一条纹，f/1.86 对焦 6 m | 0.125（口径边缘看到隐藏背景） |
| 同一条纹，f/22 对焦 6 m | 0.012 |
| 光栅刷新目标 16×11 vs 512×341 | 镜头累计 **逐位相同**（不依赖任何屏幕图像分辨率） |
| 背景条纹对比度：对焦 6 m / 1.2 m | 0.994 / 0.663 |
| 细杆芯部亮度比：对焦 1.2 m / 6 m | 0.000 / 0.086 |
| 远处发光体散景 RMS 半径 f/1.86 vs f/4 | ×1.68（近轴估计 ×2.15，离轴机械渐晕削去全开时的边缘） |
| 收集的通量 f/1.86 vs f/4 | ×3.37（近轴 ×4.62） |

代码中不存在屏幕补洞、邻域扩色或人工暗角。

### C. 光栅 vs compute 着色（`/tests/shading-gpu.html`）

同一相机、像素中心针孔（仅测试入口），线性 HDR，无 tone mapping/Bloom/光谱。192×128，剔除轮廓像素后逐材质比较（相对误差）：

| 区域 | 平均比 | 中位 | p90 |
| --- | --- | --- | --- |
| 地面（中性漫反射，接收方向光 PCFSoft 阴影 + 点光立方阴影） | 1.0000 | 0 | 0.0002 |
| 介质盒 | 0.9998 | 0 | 0.0003 |
| 实例色 | 1.0000 | 0 | 0 |
| 双面叶片 | 1.0000 | 0 | 0 |
| HDR 自发光（6,3,1） | 1 | 0 | 0 |
| 平面金属板 r=0.3 | 1.0000 | 0 | 0.0005 |
| 草地（顶点色 × MaterialX 噪声） | 1.0002 | 0.001 | 0.002 |
| 水面（反射 + Fresnel + clearcoat + 透明合成） | 0.9998 | 0.0008 | 0.0018 |
| 程序木纹（颜色/粗糙度/凹凸） | 1.0019 | 0.0098 | 0.053 |
| 曲面金属球 r=0.3 | 0.9973 | 0.059 | 0.206 |

曲面金属球的残差来自 Three 的屏幕空间 `geometryRoughness`（由法线的 dFdx/dFdy 增加粗糙度），compute 路径不实现；平面金属板证明 BRDF/PMREM 移植本身一致。木纹的 p90 来自屏幕导数凹凸与解析/差分空间梯度的差别。

天空（真实 `createDaylight`，相机在天空球心）：12:00 平均比 1.000003，p99 0.06%；17:36 平均比 1.000018，p99 0.16%。雾：光轴上光栅、compute、解析值一致（2.881）；离轴 compute 按真实路径长度 17.05 m 得 2.088（光栅按视深仍为 2.881），符合设计。

### D. 光学与光谱回归

* `/tests/hybrid-optics.html?lens=canon-fl-50mm-f1-8`：GPU/CPU 光路互易与光谱探针、跨批次前缀逐位一致（误差 0）、固定尝试数、光圈能量与采样 PDF（扩大采样区后辐亮度比 0.99986）、HDR 峰值 > 1、AF 参考目标 **真实交点 10.000 m**（V1 屏幕缓存需 ±0.3 m 容差）、正反向调焦。
* `/tests/sampling-gpu.html`：在**真实 BVH 场景**下，分块与不分块累计逐位相同，三种解析诊断一致；持续采样 4120 spp；6000×4000 共 12 块，2400 万次尝试全部计数；9504×6336 超出此适配器 8192 纹理上限，明确拒绝并保留旧图。
* `/tests/imaging-gpu.html`：0.6 / 1.2 / 3 m 条纹（真实几何条带）对焦各自最清晰（提升 ×1.76 / ×1.70 / ×2.04），像面方向标记正确。
* `/tests/hybrid-chain.html`：Three 生成的阴影贴图与 PMREM 被同一 device 上的 compute 读取；HDR 自发光 4.004 未被截断；阴影区与受光区比约 1:4.7。
* `/tests/hdr-gpu.html`：原 HDR/SDR 输出回归通过。
* Node 光谱、光学数学、镜头数据、能力预检等原有测试全部通过。

### E. 生命周期与调度（`/tests/runtime-gpu.html`）

计数器断言：静止累计、显示变化（曝光/Bloom/SDR）、解析诊断切换、光圈与对焦都 **不** 刷新光栅资源、**不** 重建 BVH；几何诊断切换重新累计；相机移动只做一次资源刷新；灯光变化只刷新资源并重写材质表；移动一个实例只重建 TLAS（BLAS 复用），AF 随之看到新位置（5.85 m）；只改材质只上传材质表；改一个几何的拓扑只重建这一个 BLAS；有限物距原生配置、失败对焦保留状态；切换镜头/分辨率/暂停 3 轮后 GPU 缓冲数与引擎显存不变（无泄漏）；无 GPU validation error、无 NaN/Inf、无 BVH 错误。

### 完整应用（`scripts/app-smoke.mjs`）

别墅场景在 SwiftShader 上加载约 350 s（光栅首帧与全部材质编译在软件中执行）。镜头模式 64 spp、+3 EV、AF-S 后：BVH 错误、未支持材质、透明层超限、无效辐亮度率均为 0；AF-S 命中真实表面 40.478 m；GPU 错误 0。截图：`artifacts/app-raster.png`、`app-lens-af.png`、`app-lens-geometry-normal.png`、`app-lens-scene-error.png`、`app-mobile.png`。

时间切换（真实时间滑块，镜头模式）：00:00 与 12:00 各采样 16 spp，光照桥接 ok（2 方向光、4 点光、2 点光阴影、半球、环境、反射），各错误率 0，GPU 错误 0。截图 `artifacts/app-lens-hour-0.png`、`app-lens-hour-12.png`。

## 性能（SwiftShader 软件适配器，非硬件 GPU）

相同别墅、相机（21,13,27 → 0,2.7,2）、Canon FL 50mm f/2.8、对焦 30 m、240×160、每批 4 spp（153,600 次尝试），8 批，GPU timestamp 为一个 compute pass：

| | V1 屏幕缓存（旧提交 32cc116，`perf-old`） | V2 几何首交点（`/tests/perf-gpu.html`） |
| --- | --- | --- |
| 每批 GPU 时间（中位） | 1.90 s | 3.68–4.03 s（两次运行；夜间 3.69–4.05 s） |
| 折合尝试路径/s | ~81 k | ~38–42 k |
| 仅光学（常量环境，跳过场景） | 0.59 s | 0.77–0.89 s |
| 光栅侧资源（热态 CPU 提交 / 提交到完成） | 捕获 15–68 ms / 6.0–6.1 s | 光照资源刷新 27–35 ms / 6.1–6.3 s（夜间 4.8 s） |
| 场景缓存未命中（占通过镜头） | 11.4%（用确定性环境近似代替） | 不存在；BVH 错误 0、未支持 0 |

在这一软件适配器上，V2 每批约慢 1.9–2.1×，换来的是真实可见性（隐藏表面、遮挡边缘、画外表面）与不受捕获分辨率限制的细节；硬件 GPU 上的比例未测，不作推断。光学 pass 本身略慢（0.77–0.89 vs 0.59 s），推测与融合着色器体积/寄存器压力有关，尚未拆分为“命中缓冲 + 独立着色”阶段——没有在硬件上做 profiling 前不引入该复杂度。

BVH 与资源：提取在主线程（复制几何属性与对象矩阵；Node 中 ~0.29 s，浏览器在 SwiftShader 争用下 ~1.9 s，冷启动包含 279 个几何的属性复制）；实例矩阵求逆与包围盒、BLAS（0.39 s）、TLAS（1.83 s）、打包（0.17 s）均在 Worker 中，合计 2.4 s；上传提交 0.45 s。GPU 常驻：BVH+表 62.5 MB，引擎（240×160 累计/输出/光学/AF）4.9 MB。仅实例变换变化时，主线程不再复制已缓存的几何属性，Worker 复用全部 BLAS 只重建 TLAS。

冷/热：首个光栅帧（编译全部场景材质）SwiftShader 75 s，不计入镜头成本；融合镜头 compute 管线编译约 2 s。

## 已知问题与限制

* **已有的 Three r183 阴影/反射交互问题（非本次引入）**：在测试页中用 `renderer.render(scene, camera)` 渲染整座场景并切换日/夜时，可出现 WebGPU 验证错误 “Destroyed texture [ShadowDepthTexture / PointShadowDepthTexture] used in a submit”。`tests/dev/night-probe.html` 在 **未修改的 V1 代码**（旧提交 + 同样的水面反射）上同样复现，去掉水面反射器后 V1 不再出现；夜间才首次激活的点光阴影（不按应用的 00:00/05:30 预热顺序）也会触发。完整应用的实际流程（启动预热、时间滑块切换、镜头模式资源刷新）记录到 0 个 GPU 错误。未修改 Three 内部；镜头侧每次刷新都重新读取当前阴影纹理，缺失时报错而不是静默无阴影。
* 光照近似：见 [场景查询](scene-query.md)（无 GI、无镜头模式 AO、几何粗糙度、参考视点反射、无折射、雾按路径长度、星为固定角半径圆盘）。
* 未在硬件 GPU、其他浏览器、移动端、9504×6336 实际分配（此适配器纹理上限 8192）上验证；`scripts/run-gpu-tests.mjs` 与 `scripts/app-smoke.mjs` 可在有 GPU 的机器上用 `--chromium` 与 `GPU_ARGS` 重跑。
* 场景动态更新路径（拓扑/变换/材质）由测试覆盖，但当前别墅场景本身是静态的，应用 UI 只提供调试用“重新扫描场景”。

## UI 委派

本机 Claude Code 2.1.300，显式 `--model claude-opus-5-5`，独立会话 `fbd71847-7724-452e-b4fb-49bf965b236f`（`--session-id` 新建，反馈轮 `--resume` 同一会话），`--permission-mode acceptEdits`，工具白名单限于读写与 `npm test`/`node --test`/`git diff|status`。保存的结果 `modelUsage` 显示 `claude-opus-5-5`；CLI 自身的辅助调用另有少量 `claude-haiku-5-5`（CLI 内部用途，非 UI 实现模型）。

* 第 1 轮（53 轮对话）：按 [V2 交接](ui-handoff.md) 修改 `src/ui/lens-ui-core.js`、`lens-ui-format.js`、`lens-ui.css`、`tests/ui-lens.test.mjs`、`docs/ui-implementation.md`：B 模式名称、真实场景/BVH 状态、近似说明、几何/法线/材质/错误诊断（几何诊断标明“重新累计”）、新的速率分组与分母、光照/未支持/BVH/透明层警告、技术诊断中的 BVH 摘要与计时、调试用“重新扫描场景”；删除缓存未命中相关 UI。
* 第 2 轮（21 轮）：依据本环境真实浏览器截图（`artifacts/ui-review/`）修订：显存提示改为 4.0 GiB（Claude 纠正了交接中的 4.2 GiB 计算）、合并模式名与 BVH 状态为一行（错误不截断）、为解析诊断与几何诊断增加图例、文档修订号去重。
* Codex 复核了 diff（只改允许范围、无渲染内部引用），集成后 `npm test` 通过，并在完整应用中截图确认新状态行与诊断视图。

最终一次全套运行（同一 SwiftShader 环境，`node scripts/run-gpu-tests.mjs`）：scene-bvh-gpu、hybrid-chain、hybrid-optics、runtime-gpu、imaging-gpu、hidden-surface-gpu、shading-gpu、sampling-gpu、hdr-gpu、daylight-transition-gpu、perf-gpu **11/11 通过**（perf 页记录了 2 次上文所述的已知 Three 阴影纹理错误，单独列出）；`npm test` 122/122；`npm run build` 成功（BVH Worker 独立打包）。

## 2026-10-15：Safari 时间切换的管线复用修复

Three r183 的 `Lighting.getNode(scene)` 为同一场景的所有相机共用一个 `LightsNode`。庭院灯阴影相机只看局部建筑层（layer 1），原来的所有灯光都只在 layer 0。嵌套阴影绘制把共享灯光列表从 7 个灯清成空数组，使主场景材质的动态缓存键改变：实测一次晨光切换销毁 1,154 个绘制对象（其中 1,148 个因动态键失效），创建 202 条渲染管线。环境贴图、雾与上下文键均保持不变。

修复把场景灯光同时加入局部阴影层，使主相机、反射相机和局部灯影相机保留一致的灯光列表。阴影相机仍只绘制局部建筑几何，不增加远处森林的阴影负担，不修改 Three 内部或关闭缓存失效检查。

验证：

- `npm test`：123 项通过，包括局部阴影/主相机灯光集合一致、森林仍被局部阴影层排除的回归断言。
- `/tests/time-pipelines-gpu.html`：完整别墅，960×640，Safari Technology Preview；按 00:00、05:30、16:30 预热后，9 次日间、晨光、夜间与黄昏切换均为 **0 新增渲染管线**，无 GPU validation error。页面断言直接统计同步和异步 WebGPU render-pipeline 创建接口；已加入 GPU 测试脚本默认列表。
- 正式应用路径：1324×907 视口、pixel ratio 1.5、HDR、光栅模式，通过实际 `timeControls.setHour` 调度 8 次时间切换，均为前台且有焦点，**0 新增管线、0 GPU 错误**。两次晨光 CPU 渲染提交为 62/60 ms，从输入至 GPU 队列完成的墙钟时间为 225/283 ms。其余切换为 175–288 ms；仍包含阴影、反射、AO 和主场景重绘成本。
- 原始记录：`artifacts/time-pipelines-before.json`、`time-pipelines-after.json`（独立光栅诊断），`time-pipelines-app-before.json`、`time-pipelines-app-after.json`（完整应用）。CPU 阶段测量嵌套、不可相加；墙钟包含帧调度和 GPU 队列等待，不是 GPU timestamp。编译缓存未清空，不作冷启动或跨设备性能推断。

同一提交还让样式从 HTML 提前加载、用轻量入口展示 10 个启动阶段与已用时间，并将镜头/配置载入时的默认光圈设为模型允许的最大开口（最小 f 值）。
