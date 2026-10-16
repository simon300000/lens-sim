# 启动管线复用与实际成像性能（2026-10-16）

基线生产代码为 `5bb9e04`，插桩提交 `fddd6ff`；最终性能候选为 `0ce4185`，分支 `codex/startup-pipeline`。后续提交补齐诊断元数据、AO 测试用纹理访问与本报告，没有改变光追 WGSL、镜头数据或采样算法。默认仍为**移动中心 128 分区、5% 全域混合**。

## 结果

下表均为本平台、相同场景设置的前后对照。启动指 `createScene` 初始化墙钟，不含此前模块下载；应用成像为实际 RAF、采样、resolve、Bloom/HDR 显示调度下的 **480×320、256 spp** 完成时间，排除预热，统计/PixelAccum 回读和哈希在计时之后进行。

| 指标 | macOS 基线 → 最终 | Windows 基线 → 最终 |
|---|---:|---:|
| 应用启动均值 | 35.614 → **16.723 s**（−53.0%） | 26.391 → **17.518 s**（−33.6%） |
| NodeBuilder 构建 CPU 墙钟均值 | 30.047 → **12.073 s** | 17.287 → **7.100 s** |
| NodeBuilder.build 调用 | 970 → **625** | 970 → **625** |
| 渲染管线创建 | 771 → **527**（−31.6%） | 771 → **527** |
| 计算管线创建 | 6 → **6，独立任务并发** | 6 → **6，独立任务并发** |
| 着色器模块创建 | 798 → **565** | 798 → **565** |
| 实际应用 256 spp 均值 | 4.655 → **3.090 s**（吞吐约 1.51×） | 2.0015 → **2.0031 s**（基本持平） |
| 最终启动最大主线程心跳间隔 | **346 / 355 ms** | **1358 / 1348 ms** |

macOS：3 轮基线、2 轮最终启动，各轮 3 次应用成像，共 9 / 6 次。基线启动为 33.209 / 34.784 / 38.850 s；最终为 16.809 / 16.636 s。Windows：各 2 轮启动、各 6 次应用成像。所有纳入比较的运行均前台有效、无页面/API/GPU 错误。各轮原值均保留，均值不是单次最佳成绩。

这里的创建次数覆盖**默认相机、夜景/晨光/当前时刻和首次镜头显示的启动预热**，不是所有可能相机与材质状态的全项目数量。着色器模块、渲染管线、计算管线、节点构建是不同计数，不应相加当作“着色器源码数量”。

## 实际修改

1. **法线预处理只生成所需的法线和深度。** 新的 [pass-reuse.js](../../src/rendering/pass-reuse.js) 使用 Standard 材质的自定义 fragment，保留木纹、水波的 `normalNode`、顶点图和栅格状态，跳过无用 PBR 灯光及反射图。特殊 fragment/MRT、alpha test、贴图法线、裁剪等回退原材质。
2. **每帧统一准备 AO。** [raster-ao.js](../../src/rendering/raster-ao.js) 在 beauty 之前准备 normal → GTAO → denoise，PBR 材质直接读取同一张 GPU 纹理。避免在逐材质分批构建时反复 setup RTT/GTAO、失效并重建其管线。这里没有 CPU 图像回读或第二个设备。
3. **光照资源刷新只绘制必要的外层触发者。** [lighting-resources.js](../../src/rendering/lighting-resources.js) 的微型目标像素本来就不用于成像。现在外层仅画专用阴影接收者和水面；Three 的阴影 caster 和反射相机仍绘制完整所需场景。通过相同的上下文及嵌套深度复用反射管线，接收者隔离 AO，虚拟相机不使用主视角 AO。
4. **独立计算管线并发准备。** [optical-engine.js](../../src/rendering/optical-engine.js) 同时启动六项创建；[three-interop.js](../../src/rendering/three-interop.js) 在任何 await 之前同步弹出设备级错误作用域，用 `allSettled` 收齐错误，避免并发任务交叉消费 scope。
5. **预算预热和纯 CPU Worker。** [startup-warmup.js](../../src/rendering/startup-warmup.js) 以 48 ms 软预算准备新变体，轮间让浏览器处理输入/绘制，不逐轮等待 GPU。单个节点构建仍可能超过预算。初次/切镜头通过 [pupil-precompute.js](../../src/optics/pupil-precompute.js) / [pupil-worker.js](../../src/optics/pupil-worker.js) 做纯 CPU 出瞳追迹，转移一次 32 KiB 表缓冲并校验请求 key。现有同步 setter 保留兼容，GPU 设备、纹理和累计缓冲没有移入另一个设备。
6. **正式成像最多两批在途。** [hybrid-runtime.js](../../src/rendering/hybrid-runtime.js) 在同一有序 GPU queue 上允许最多两批，减少慢批次完成与下一次 RAF 之间的空隙；交互期间仍按单批门限。没有新增逐帧图像传输或无界队列。Worker 加载使用独立版本号，移动相机/改变灯光不会把有效请求永久留在 loading；无效镜头 ID 也不会取消有效加载。

Astra high 做了两轮只读专项复查。发现的法线材质覆盖、AO 继承/稀疏预通道依赖、异步加载取消及统计口径问题均已修正并加入验证。没有删除实例 UUID、伪造材质缓存键或让不同对象共享其实际实例绑定。

## 阶段耗时

以下是完整有效单轮，单位秒。macOS 使用基线第 2 轮及最终第 2 轮；Windows 展示最终两轮。阶段划分按加载提示边界，包含该阶段内的 CPU、异步等待与让出主线程时间。

| 阶段 | Mac 基线 | Mac 最终 | Windows 最终 1 / 2 |
|---|---:|---:|---:|
| GPU/HDR 检测 | 0.007 | 0.006 | 0.212 / 0.187 |
| 场景几何创建 | 0.325 | 0.348 | 0.276 / 0.278 |
| 天空、日照、反射初始化 | 0.069 | 0.058 | 0.061 / 0.058 |
| 夜景、灯光与阴影预热 | 17.526 | 14.593 | 13.451 / 13.347 |
| 晨光预热 | 0.105 | 0.075 | 0.069 / 0.078 |
| 当前时刻预热 | 0.214 | 0.140 | 0.621 / 0.625 |
| 几何提取、启动 BVH 任务 | 0.381 | 0.063 | 0.092 / 0.086 |
| 光学管线、镜头/出瞳准备、等待 BVH | 3.259 | 1.076 | 2.100 / 2.069 |
| 首次镜头成像及显示预热 | 12.898 | 0.277 | 0.706 / 0.720 |

Mac 初次光追显示的巨大准备成本主要由重复的整场景刷新变体消除。夜景阶段最终包含分批让出主线程时间，不能只根据阶段墙钟判断节点构建量；该轮 NodeBuilder CPU 总计从 29.205 s 降到 12.085 s。

BVH 与光学准备有重叠，以下分项**不能简单相加**：

- Mac 补充阶段记录：BVH 整体墙钟 **1.219 s**，其中提取 22 ms、上传 CPU 提交 25 ms；Worker 报告展开 110 ms、BLAS 121 ms、TLAS 679 ms、打包 71 ms。该补充运行只用于拆分阶段，不加入上表启动/成像均值。
- Windows 最终两轮：BVH 整体墙钟 **1.238 / 1.233 s**；六条计算管线及引擎资源初始化 **1.306 / 1.302 s**；出瞳物理构建约 **0.746 / 0.711 s**。异步 Promise 耗时总和不是并发任务的关键路径。
- Mac 最终两轮：计算管线及资源初始化均约 **19 ms**；Worker 表构建 **814 / 793 ms**。此处缓存状态不同，不能把这些数值直接当作 Mac/Windows 硬件编译能力比较。

Windows 仍有约 **1.35 s** 的停顿，发生在预算预热后的首次完整绘制；该区间的实际 `NodeBuilder.build` 与管线创建调用均为 0。它不是通过 Map 净增量推断的“零新建”，而是以原始事件计数验证。不能称启动完全无卡顿，也不应仅凭阶段标签把它判为新着色器编译；对已保存事件的追加只读分析显示，该区间内已包装原生调用总并集仅 **0.9 / 1.2 ms**，约 **1.319 / 1.308 s** 位于 render 内部没有已插桩事件的空档。可以排除这些 submit/finish/draw/setPipeline 调用本身承担主要同步阻塞，但 writeBuffer、资源创建、绑定更新、JS/GC 仍在盲区，不能直接判定是纯 JS 或编译。[区间分析数据](startup-optimization-2026-10-16/windows-final-draw-gap.json)。

## 纯光追批次与完整应用吞吐分开

| 微基准（4 spp/批） | 基线均值 | 最终均值 | 解释 |
|---|---:|---:|---|
| Mac 原生默认光学，GPU timestamp | 47.950 ms | 47.791 ms | 接近，未确立内核加速 |
| Mac 同组提交到完成墙钟（含 resolve） | 49.563 ms | 49.531 ms | 基本持平 |
| Windows 旧固定协议，GPU timestamp | 10.731 ms | 10.856 ms | +1.16%，保留观测到的变化 |
| Windows 同组提交到完成墙钟 | 12.869 ms | 13.538 ms | +5.20%，不宣称零退化 |

Mac 原生默认组：同应用的默认 Canon FL 50、seed1、光谱、原始像面，预热后每 trial 64 spp；基线 48 个、最终 96 个测量批次。Windows 旧组使用既有固定 32 spp、seed77、f/2.8、无色散、固定对焦测试副本；前后设置相同。Windows 最终还保存了新原生 64 spp 组，但它与旧组的相机/光学设置不同，**不能跨组计算加速比**，也不能拿这些微基准横向推导两台硬件的倍数。

Windows 旧微基准的夜间切换曾触发既有 Three 阴影纹理错误，该错误轮保留在远端原始报告并排除；正式 kernel 对照固定为日间。不能据日间结果宣称该旧副本的夜间路径通过。

本轮光追 WGSL 和物理积分未改。Mac 的完整应用收益属于采样/显示调度的综合结果；Windows 完整应用约 2 s，前后基本持平。纯内核没有稳定提速，Windows 微基准仍有小幅回退/波动，不能以启动收益掩盖这一点。每批 queue fence 是微基准计时手段，不能等同于生产路径每批 CPU 同步阻塞。

## 正确性与边界

- Mac 最终新增测试：木纹/水波法线 3 视角、AO 独立准备在 192×128 / 240×160 / 144×96 三次尺寸变化、改变视角与灯光后的反射，全部逐像素最大差 **0**。
- Chrome/Windows 的木纹/水面法线、反射、Worker 表测试通过。Worker 返回的 uniform 与同平台同步物理追迹逐字节一致。
- 实际应用 PixelAccum 在**各平台内部**前后逐字节相同；Mac 应用 256 spp SHA-256 为 `6beadb2b6856493089f689f20abdd5ab600ad3505b909073372839663d05052c`，Windows 为 `c4b1e108c38bb455cb24c5d429461ae19a63a8a412911f3e1a73ae4cf949f894`。不要求不同 GPU/着色语言后端间逐位相同。
- Mac 原生 64 spp 与 Windows 旧固定协议的累计字节也各自前后相同。所有正式对照数值/BVH/radiance 错误为 0；保留既有有界透明合成的命中记录，没有为通过测试放宽光学容差。
- 运行时验证覆盖真实交点 AF、镜组移动资料、多镜头/配置、光照/几何变化、加载中 camera/light 变化、无效镜头 ID、两批上限、在途 reset、暂停恢复、分辨率切换和缓冲生命周期；两平台通过。
- 最终预热最后一次完整绘制的**实际新增节点和管线调用均为 0**。同时保存缓存大小净增量，但不以净增量代替实际事件计数。
- 158 项 Node 测试通过；生产构建通过。光学默认参数、原始镜头像面和 5% 全域混合保持不变。

反射统一使用与原光追资源刷新相同的无主视角 AO 语义，移除主相机屏幕 AO 在镜面相机上的错误继承。法线和 AO 本身已做独立逐像素对照；不把整个导航光栅画面宣称为逐像素不变。

## 环境与复现

- macOS：Apple M2 Pro、macOS 27.0.1、Safari Technology Preview 27.0 / 22627.1.2.1，1324×907 CSS 像素、DPR2，应用 pixel ratio 上限 1.5，HDR `rgba16float / extended`。
- Windows：RTX4090、驱动 610.88、Chrome 155.0.8059.82，1280×720、DPR1，HDR canvas `rgba16float / extended`，显示链路 `displayHigh=false`；每轮独立 Chrome profile，启动参数保存在 JSON。
- 两平台均为 Vite 开发模式、Three 0.183.2。Mac 同 STP 进程反复导航；Windows 独立 Chrome profile。未清 OS/驱动持久缓存，不宣称严格冷编译，也未把开发模式绝对时间当作生产冷启动保证。
- 测试 boot 为安装 Three 原型计时，会先加载 Three，再执行真实 startup/main；比较的是相同 harness 下的应用初始化与运行，不拿此前模块下载或初始 UI 绘制推断全部页面冷加载。
- [启动测试页](../../tests/startup-profile.html)：`?run=自定义名称&bench=1`，结果在 `window.__startupReport`；`bench=1` 自动测实际应用和原生 kernel，照片回读在计时之后。
- [正确性测试页](../../tests/startup-reuse-gpu.html)、[运行时测试页](../../tests/runtime-gpu.html)。可选本机 POST 收集器接收 `127.0.0.1:5175/report`；收集器不可用时页面/全局结果仍保留。
- 摘要重算：`node scripts/analyze-startup-profile.mjs docs/benchmarks/startup-optimization-2026-10-16/mac-final-1.json.gz`。区间取并集避免嵌套 render 重复计时；失焦、后台、错误、未完成轮不纳入性能结论。

## 数据与进一步方向

[Mac 汇总](startup-optimization-2026-10-16/mac-comparison.json)、[Windows 完整轮次汇总](startup-optimization-2026-10-16/windows-final-summary.json)、[Mac 补充分阶段记录](startup-optimization-2026-10-16/mac-stage-details-summary.json)、[GPU 像素/Worker 正确性](startup-optimization-2026-10-16/mac-startup-reuse-gpu.json)、[运行时正确性](startup-optimization-2026-10-16/mac-runtime-gpu.json)。Windows 原始报告留在协作测试工作树，汇总中记录来源会话及轮次；Mac 原始 JSON 以无损 gzip 保存。

| 运行 | 原始数据 | 摘要 |
|---|---|---|
| Mac 基线 1 | [JSON.gz](startup-optimization-2026-10-16/mac-baseline-1.json.gz) | [JSON](startup-optimization-2026-10-16/mac-baseline-1-summary.json) |
| Mac 基线 2 | [JSON.gz](startup-optimization-2026-10-16/mac-baseline-2.json.gz) | [JSON](startup-optimization-2026-10-16/mac-baseline-2-summary.json) |
| Mac 基线 3 | [JSON.gz](startup-optimization-2026-10-16/mac-baseline-3.json.gz) | [JSON](startup-optimization-2026-10-16/mac-baseline-3-summary.json) |
| Mac 最终 1 | [JSON.gz](startup-optimization-2026-10-16/mac-final-1.json.gz) | [JSON](startup-optimization-2026-10-16/mac-final-1-summary.json) |
| Mac 最终 2 | [JSON.gz](startup-optimization-2026-10-16/mac-final-2.json.gz) | [JSON](startup-optimization-2026-10-16/mac-final-2-summary.json) |
| Mac 分阶段补充 | [JSON.gz](startup-optimization-2026-10-16/mac-stage-details.json.gz) | [JSON](startup-optimization-2026-10-16/mac-stage-details-summary.json) |

本轮采用 CPU 出瞳 Worker、已有 BVH Worker、主线程预算构建和单 GPUDevice 资源共享。完整 Three/OffscreenCanvas Worker 主要能进一步隔离 UI 停顿，不会消除剩余节点构建量；若继续迁移，应让 Three、光追与纹理桥接一同归同一个 GPU 所有者，主线程只发送输入/控制状态，避免逐帧图像往返。

Astra 复查建议优先细分 Windows 首次完整绘制的剩余停顿，再评估绑定安全的实例 shader 模板复用。Three r183 的实例 UUID 缓存同时承载实际对象绑定，不能直接删除。试验也合并过五组兼容叶片：没有进一步减少渲染管线，因此最终撤回，保留原始场景/BVH 排列。未把原生渲染、镜头切换和所有相机位置宣称为普遍无卡顿或全指标提速。
