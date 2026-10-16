# lens-sim

使用 Three.js 原生 WebGPU 后端的程序化三维场景与日月光照模拟。当前场景为「山庭 SANTEI」山间别墅及日式花园，支持 HDR 输出和 SDR tone mapping 回退。

## 本地打开

```powershell
git submodule update --init --recursive
npm ci
npm run dev
```

用支持 WebGPU 的浏览器打开终端显示的本地地址。网页未发布。

| 操作 | 作用 |
| --- | --- |
| 左键拖动 | 原地环视（随视场角调节灵敏度） |
| ⌥/Alt + 拖动、中键拖动 | 绕光标下的点环绕 |
| 右键 / Shift + 拖动 | 平移（按抓取点距离缩放） |
| 滚轮 / 触控板捏合 | 朝光标处推进，步长与到表面的距离成比例 |
| 双击 | 平滑转向该点（再按 F 对焦） |
| W A S D · Q E · 方向键 | 地面行走 · 下降/上升 · 转头；Shift 加速、Alt 减速 |
| F · L · P | AF-S · 镜组工作台 · 性能诊断浮窗 |

左侧「镜头」面板含拍摄常用操作与「保存图片」（镜头模式导出完整分辨率的累计图像 PNG，曝光 + ACES 与 SDR 显示一致，不含 Bloom）。**镜组工作台**（L）显示镜组截面与各视场光线（同 lens-bench 布局规则），可编辑处方（插入/删除面、设为光阑、撤销/重做；随配置变化的数值写回该配置），并可导入 CODE V `.seq` / Zemax `.zmx`（解析器移植自 lens-bench `lensio.js`）。编辑与导入的处方在浏览器中走与构建相同的适配与静态预检，仅在本页会话有效，不写入分享链接。**性能诊断**（P）是可拖到任意角落的浮窗：采样速度、光线吞吐、GPU 单块耗时曲线、光线去向与场景资源。

```powershell
npm run build
npm run preview
```

生产构建保存到 `dist/`。构建后的网页不需要外部 CDN；用 HTTP 服务打开，不能直接双击 HTML。

镜头数据以 `vendor/lens-bench` 中固定提交的原始文件为唯一来源。`dev`、`test` 和 `build` 会自动转换数据到被 Git 忽略的 `public/lenses/`；这些是生成产物，不在主仓库重复提交。也可用 `npm run build:lenses` 手动重新生成。

## 场景

- 木结构别墅、立缝屋顶、木廊、滑开障子门与开放的榻榻米客厅。
- 室内茶桌、茶具、坐垫、灯笼、书架与壁龛。
- 草地、花瓣与茎叶、蕨类、玉簪、竹子、灌木、分枝树与独立几何叶片。
- 不规则石岸鱼塘、锦鲤、荷叶、水生植物、竹制水景与石灯笼。
- 花园桌椅、茶具、石径、层叠远山与山林。

模型、木纹、叶片、水面法线及地形都在代码中生成，没有使用网上现成材质、纹理、HDR 或三维模型，也没有外部字体请求。

场景保持静态。光栅视图按需绘制；镜头视图可累计到目标 spp 后停止，或选择「持续采样（不限 spp）」一直累计；暂停或页面不可见时停止。不支持 WebGPU 时明确显示提示，不会悄悄切换到 WebGL。

## 真实镜头渲染器 V2：几何首交点 + 实时光照

侧边「镜头」面板保留 **A · 光栅近似** 导航/对照，选择 **B · 镜头追迹** 启用实际镜组。每次尝试从 36×24 mm 传感器采样一个像素位置、一个后部参考面圆盘位置和一个连续波长（380–780 nm），反向逐面折射；玻璃采用当前镜头的波长相关 n(λ) LUT，保留全反射、物理孔径裁切和真实通光损失。失败样本不会补发，f32 XYZ 之和始终除以全部尝试次数。不是最终图片的景深或 RGB 位移滤镜。

首选镜头来自上游真实数据 **Canon FL 50mm F1.8 / INF**，11 面，实际近轴焦距约 49.06 mm，初始光圈采用该结构允许的最大口径。各玻璃界面的通光半径均已知；独立 stop 半径由原始 fno 与入瞳倍率标定，仍明确显示缺少独立 stop 数据的提示。配置选择使用原始离散结构、像面和物距，不猜测商业镜头的对焦组轨迹。当前静态预检有 455 支镜头、1967 个配置可选；这不代表逐镜头 GPU 成像验收。XODD 扩展奇次非球面按原始归一化半径与全部整数次项计算；DOE 按原始阶次、归一化半径和相位梯度进行波长相关的几何追迹；未提供的衍射效率、其他阶次能量及相干干涉不作推断。其他特殊面、未知玻璃及不满足当前初始化/数值条件的配置不可选，并保留原因。原生零间距平面盖玻璃使用完整后向余弦半球采样，保留像面位置和界面折射；详见 [特殊面与原生像面验收](docs/validation-special-surfaces.md)。

- 光圈只改变 stop 的实际半径，受数据约束；不额外乘 1/f² 或人工暗角。
- **AF-S / F** 沿实际参考光路取中心深度目标，在 GPU 正向追迹固定光束并归约最佳像面；手动距离与 AF 共用同一调焦状态。∞ 使用平行物方光束。
- **像距** 是末面顶点至传感器的 mm 距离，可 ±0.01 mm 微调；固定镜组、传感器轴向调焦是首版的等效机构。
- 可选择持续采样，超过 4096 spp 后仍沿原随机序列继续，保留暂停/继续。目标 spp 提高会继续原序列；曝光、Bloom、HDR/SDR 与诊断视图只改变显示，不重置成像。暂停/继续和重置只控制累计。传感器固定 3:2，通过 letterbox 适配窗口。
- 分辨率从小尺寸预览扩展到 6000×4000（24 MP）、6720×4480、7362×4908、7953×5302、8256×5504、8688×5792 和 9504×6336（60.2 MP，6100 万级相机）。大图以行块存储并逐块采样，避免单个存储绑定超限；计数按全图完成的 spp 显示。每像素累计记录 64 字节（XYZ、尝试数与各状态计数），最高尺寸累计和输出约需 4.0 GiB（4.3 GB），受 GPU 纹理尺寸及可用内存限制；超出适配器限制的尺寸明确拒绝并保留旧图。场景细节不再受任何屏幕捕获分辨率限制：每条路径在真实几何交点处着色。
- 交互时降到 240×160、1 spp/批，停止后恢复所选分辨率。参数在 buffer 中更新，不逐镜头重编译 shader。只有场景、相机或捕获范围改变才重新光栅捕获。

一个 Three WebGPURenderer / GPUDevice：光栅负责导航视图、太阳/月亮/灯具阴影贴图、PMREM 环境和水面平面反射；镜头 compute 在同一设备上直接读取这些纹理。每条通过镜组的出射光线与**完整注册场景几何**（两级 BVH：每种几何一个共享 BLAS，每个实例一条 TLAS 记录；构建在 Worker 中进行）求最近有效交点，并在该交点按场景材质（含顶点/实例色、金属/粗糙度、程序木纹与凹凸、草地色变、水面）和 Three r183 的物理光照模型着色。透明混合层沿同一射线有界合成。天空、太阳盘、月亮与星空是显式注册的环境对象，按方向解析查询。镜头物理挡光/全反射计零贡献并计入尝试，直接跳过场景求交；场景背景、未支持材质、BVH 遍历错误、透明层超限各自单独计数，不会互相冒充。AF-S 沿当前镜头参考主光线取真实场景的第一个不透明交点。静止累计时只提交镜头 compute 与显示；相机移动只刷新一次光栅资源，不重建 BVH；对焦/光圈不重建 BVH 也不重画阴影。

限制（明确的实时近似，不是完整路径追踪）：无场景多次漫反射/全局光照；阴影来自光栅阴影贴图（不发阴影射线）；镜头模式没有屏幕空间 AO；Three 的屏幕空间几何粗糙度不在 compute 中实现（弯曲金属高光略有差异）；水面反射是参考视点平面反射，透明层不模拟折射；雾按真实路径长度计算；星空用固定角半径的圆盘表示光栅精灵。RGB→非负光谱是保持颜色匹配的近似 metamer，不能恢复真实材质/灯具光谱；CIE 匹配函数采用有来源的解析近似。T=1 是理想几何透射，不是 T-stop；没有鬼影、镀膜、吸收、波动衍射成像、噪声或运动模糊。未知通光口径不会由 sdDraw 冒充；使用有限数值域的来源会显示。上游未提供各玻璃厂商认证的波段范围，380–780 nm 是已检查公式的工作区间。细节见 [场景查询](docs/scene-query.md) 与 [V2 验收记录](docs/validation-v2.md)。

计算、采样测度、固定全局标定 `4/π`、坐标和来源见 [光学数学](docs/optics-math.md)、[光谱](docs/spectral.md)、[场景查询](docs/scene-query.md)。

## 数据来源、许可与更新

`vendor/lens-bench` 是 [anvcor/lens-bench](https://github.com/anvcor/lens-bench) 的 submodule，main 分支固定在 **8274ca9d34bf75611f5a3c00af54a6a8498f076b**。运行时仅按镜头加载生成的数据，绝不加载上游应用或光学后端。上游数据/派生公式约定保留 **GPL-3.0** 来源，完整许可保存在 submodule 和 `public/lenses/LICENSE.lens-bench.txt`，没有改标其他许可。场景材质依然完全由本项目程序生成。

构建不会自动拉取 main。手动更新时：

```powershell
git -C vendor/lens-bench fetch origin main
git -C vendor/lens-bench checkout <已审核的完整SHA>
npm run build:lenses
npm test
npm run build
```

审查 gitlink、适配器、生成结果、许可和测试；提交 gitlink 与适配器/文档的变更，不提交 `public/lenses/` 生成产物。详见 [数据适配](docs/lens-data.md) 与 [能力预检/失败采样审计](docs/lens-capabilities.md)。

## 验证与 UI 分工

V2 的 UI 小改由本机 Claude Code 2.1.300 以显式 `claude-opus-5-5` 在独立会话 **fbd71847-7724-452e-b4fb-49bf965b236f** 中完成（两轮，第二轮依据真实浏览器截图），只修改 `src/ui/`、UI 测试和 [UI 实现记录](docs/ui-implementation.md)；BVH、着色、光学、GPU 生命周期与共享入口由 Codex 负责。V1 的 UI 来自会话 7ab40175-5f8b-4e4a-a2cd-0418b2698331（见 V1 记录）。

```powershell
npm test
npm run build
```

开发服务器还提供实际 WebGPU 验收页（不会以 mock 替代）；`node scripts/run-gpu-tests.mjs` 用 Playwright Chromium 依次运行并把结果写入 `artifacts/`，`node scripts/app-smoke.mjs` 跑完整应用：

- `/tests/scene-bvh-gpu.html`：GPU 两级 BVH 对照 f64 暴力求交（最近交点、实例、primitive、重心、正反面、隐藏表面）。
- `/tests/hidden-surface-gpu.html`：前景细杆后的隐藏背景、与光栅分辨率无关、对焦扫描、散景随光圈变化。
- `/tests/shading-gpu.html`：光栅 vs compute 着色（材质、阴影、PMREM、木纹、草地、水面、天空、雾）。
- `/tests/hybrid-chain.html`：Three 生成的阴影/PMREM → 同一 device 的 compute → HDR 显示。
- `/tests/hybrid-optics.html?lens=canon-fl-50mm-f1-8`：光路互易、连续光谱、固定尝试、跨批次、孔径与 PDF 能量、HDR、AF。
- `/tests/runtime-gpu.html`：失效规则（几何/材质/光照/相机/光学/显示）、TLAS/BLAS 最小重建、AF 真实交点、无泄漏。
- `/tests/imaging-gpu.html`、`/tests/sampling-gpu.html`、`/tests/hdr-gpu.html`、`/tests/daylight-transition-gpu.html`：原有回归。
- `/tests/perf-gpu.html`：完整别墅的 BVH 构建、资源刷新与每批 GPU 时间。

实际平台、数值、耗时来源和未验项目见 [V2 验收记录](docs/validation-v2.md)（V1 见 [V1 验收记录](docs/validation-v1.md)）。浏览器兼容入口 `window.__SANTEI__` 保留，并扩展 `.hybrid` / `.diagnostics.hybrid`。

## 昼夜与天文

底部面板可按分钟调整 `00:00–24:00`，并改变观景日期；`24:00` 代表次日零点。默认地点为日本长野县松本（北纬 36.238°、东经 137.971°、海拔 660 米），使用固定日本标准时间 UTC+9。初始日期为 2026-09-26，初始时间为 16:30。

太阳与月亮使用 Astronomy Engine 的观测者视差、岁差及标准大气折射计算，月亮采用真实月相和受光方向。世界坐标 +X 向东、-Z 向北；日月方向同时决定阴影方向。山脉会遮挡低角度光线。

日月直接光采用 lux，纸灯和石灯采用坎德拉及亮度，并使用统一数值归一化。晴空消光、暮光、色温和摄影曝光随时间连续变化。场景包括程序化天空环境照明、间接光环境遮蔽、柔和阴影、曝光后的轻微眩光，以及鱼塘的实时平面反射。未使用外部天空图、HDR 或材质。

天文位置有独立参考数据校验；大气、散射、地表反弹和相机曝光为晴空近似，不是对某天真实天气的测量，也没有完整路径追踪的多次反弹全局光照。

```powershell
npm test
```

验证 NREL/USNO 天文参考数据、月相、宿主时区无关性、全天状态、日出日落连续性和 24:00 跨日。

## HDR 渲染与输出

着色器以 32 位浮点计算线性光照；场景颜色、中间后处理、环境预过滤和水面反射使用 `RGBA16F`。曝光只计算一次，Bloom 在曝光后的 HDR 值上提取高光。

网页先检测浏览器是否真正接受 `rgba16float` 和 `toneMapping.mode="extended"`，再配置主画布。支持时直接输出曝光后的 HDR 值，保留高于参考白色 `1.0` 的高光；不支持时保留内部 HDR 管线，仅在最终输出阶段应用 ACES tone mapping，输出 SDR。

两条路径最后只做一次 sRGB 编码。`rgba16float` 表示存储精度，不会把 `colorSpace="srgb"` 自动变为线性编码。右下角的 HDR/SDR 标记说明所选输出路径；悬停显示浏览器与当前显示链路的情况。显示器报告标准动态范围不会触发浏览器兼容回退，系统与显示器决定最终可见的 HDR 亮度。

`npm test` 验证能力检测、静默忽略扩展模式、异步验证错误和清理。开发服务器的 `/tests/hdr-gpu.html` 用实际 GPU 验证 HDR/SDR 两条着色器输出路径：线性 `4.0` 保留在中间缓冲，HDR sRGB 输出约 `1.825`；SDR 路径输出限制在 `0–1`。正常模式不回读整图；显式使用 `?gpu-diagnostics=1` 才在启动时统计夜景画布，结果位于 `window.__SANTEI__.diagnostics.hdr`。开发时可按需调用 `window.__SANTEI__.captureOutputRange()` 检查当前实际输出。

## 文件

`src/main.js` 管理 WebGPU、相机、环境遮蔽与初始化，`src/scene/santei-scene.js` 组装场景（水面反射与草地色变在 `src/scene/procedural-materials.js`，常量在 `procedural-params.js`）；镜头场景查询在 `src/scene/`（注册、提取、BVH 构建/Worker）与 `src/rendering/`（`scene-intersector.wgsl`、`scene-shading.wgsl`、`scene-resources.js`、`lighting-resources.js`）；`kit.js` 提供建模工具和程序化木纹。建筑、花园、植物和山林分别位于 `villa.js`、`garden.js`、`vegetation.js`、`landscape.js`。`astronomy.js` 计算天文与光照状态，`lighting.js` 驱动天空、光源和环境反射，`time-controls.js` 提供时间面板，`details.js` 添加构造细节及夜灯。

浏览器中 `window.__SANTEI__.diagnostics` 提供后端、模型数量和构建状态，供开发检查。

### 启动预热与时间切换

加载阶段在 Worker 中构建场景 BVH，并准备光照资源刷新、首个镜头样本及显示管线，随后恢复默认光栅视图，首次切换复用已准备的结果。时间拖动每动画帧合并一次更新，在帧开始、任何场景 pass 绘制之前提交全部时间状态；天空环境反射与照明、曝光同步提交，避免新夜间曝光混用旧白天环境导致全屏过曝。

`/tests/sampling-gpu.html` 验证分块与未分块的逐位采样一致性、各诊断显示、持续采样超过 4096 spp、24 MP 与 6100 万级图像的完整像素计数及 GPU 错误。`/tests/daylight-transition-gpu.html` 验证正午到夜间、晨光及傍晚的第一帧亮度。运行前需 `npm run build:lenses`。
