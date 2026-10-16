# Safari Technology Preview 启动停顿归因（2026-10-16）

当前 main `5bb9e04`，Three.js r183。Safari Technology Preview 27.0 / 22627.1.2.1，macOS，本机 Vite 开发页，1324×907 CSS 像素、devicePixelRatio=2（应用自身限制渲染 pixel ratio≤1.5），默认 480×320 光追、Canon FL 50、移动中心 128 分区、5% 全域混合。未改变生产代码或执行顺序。

**主要停顿在 Three.js 主线程材质节点构建与着色器代码生成，而非同步 WebGPU 管线创建 API 内。** 两轮有效深入测量中，970 次 `NodeBuilder.build()` 的区间并集合计 30.979 / 32.961 秒，占初始化约 77.8% / 86.9%。这个方法包含材质节点构建、setup/analyze/generate 等工作，不能把它全部称作驱动编译时间。

| 指标 | 清缓存并重启 STP 后（run 3） | 同进程重复加载（run 4） |
|---|---:|---:|
| 应用初始化墙钟（不含先前模块下载） | 39.837 s | 37.930 s |
| NodeBuilder.build 区间并集 | 30.979 s | 32.961 s |
| 最大主线程心跳间隔 | 20.106 s | 19.085 s |
| 首帧预热阶段最大心跳间隔 | 11.972 s | 15.104 s |
| createRenderPipeline 同步调用累计 | 12 ms | 20 ms |
| createShaderModule 同步调用累计 | 2 ms | 8 ms |
| 6 次 getCompilationInfo Promise 延迟之和 | 485 ms | 82 ms |
| 6 次 createComputePipelineAsync Promise 延迟之和 | 31 ms | 77 ms |
| 出瞳表物理预计算 | 未采集 | 1800 ms |
| 计算管线及引擎资源初始化 | 未采集 | 181 ms |
| 前台有效 / 页面与 GPU 错误 | 是 / 0 | 是 / 0 |

两轮均观察到 **771 次渲染管线创建、6 次计算管线创建、798 次着色器模块创建**。这是创建调用次数，不是不同源码数量；后两类的数量也不能直接相加当作着色器数量。970 次节点构建包括不同场景/材质/渲染状态的构建请求。

Run 3 最大 20.106 秒停顿内，NodeBuilder 占 19.414 秒（96.6%），同步 WebGPU 创建调用占 11 ms；另一段 11.972 秒停顿内，NodeBuilder 占 11.480 秒（95.9%），同步创建调用占 2 ms。Run 4 两段对应 NodeBuilder 占比约 95.9% / 96.5%。清浏览器缓存和重启没有消除这些主线程长任务。

“编译真实镜组、光谱采样与自动对焦”提示也包含非编译工作。Run 4 此阶段总计 2.064 秒，出瞳表记录 buildMs=1801（物理追迹 1800 ms、派生 1 ms，222172 个探测，physicalCacheHit=false），引擎初始化 181 ms。不能把这段提示下的等待全部归为着色器编译。Run 3 该阶段有 6.452 秒心跳间隔，未采集出瞳表单独计时，保留归因不确定性。

## 方法和边界

- [测试页](../../tests/startup-profile.html)复用实际 index 页面结构，加载实际 startup/main，独立标签页。进入应用前包装 WebGPU 原型方法，记录调用进入/返回时间及异步 Promise 完成时间。
- 深入测量再包装实际 Three.js 导出的 NodeBuilder.build 与 renderer.render；以 16 ms 定时器的 >80 ms 间隔捕捉主线程无法调度的长任务。区间并集避免嵌套 render/build 重复计时。
- 记录 visibility/focus 变化和每次调用的状态。页面初次导航聚焦之前的模块载入不计入应用性能比较。应用初始化期间发生失焦的 run 2 标为无效，仅保留原始诊断。
- 用户授权后，通过 STP Develop → Empty Caches 清理缓存并退出、重启 STP。没有清理或重启主 Safari。**该操作不证明系统/Metal 驱动持久缓存也被清空，不能宣称严格驱动冷编译。**
- API 同步耗时不能代表所有后台驱动编译耗时；异步延迟与 queue 等待也不等于纯 GPU 执行时间。本结果确定的是：本次主线程大段停顿与 NodeBuilder 构建同步重合，创建 API 本身没有占据这些秒级区间。
- 本次测的是开发页面启动，不是稳态成像吞吐。插桩、CPU JIT 和系统负载会影响绝对时间，以上为单轮数据，不把两轮差异当优化收益。没有执行正式累计渲染性能比较。
- Run 1 为轻量插桩、清缓存重启后基线：应用初始化约 46.5 秒、最大间隔22.919秒；没有 NodeBuilder 计时，不与深入插桩做精确性能比较。
- 所有完成轮页面 ready=true、errors=[]。已关闭本次测试标签页，保留原始 Start Page；已有 dev server 继续运行。

优先改进应针对节点构建数量和主线程调度：查重复材质/节点图与缓存键、分批预热并主动让浏览器处理输入与绘制，再评估异步管线预编译。只把 6 条计算管线改成 Promise.all，无法消除本次 20 秒级停顿。Worker 化需要单独评估 Three.js/DOM 依赖及可迁移范围，当前没有实施或验证。

## 原始结果

- [Run 1 原始](startup-stp-2026-10-16/run-1.json.gz) / [摘要](startup-stp-2026-10-16/run-1-summary.json)
- [Run 2 原始（失焦，排除）](startup-stp-2026-10-16/run-2.json.gz) / [摘要](startup-stp-2026-10-16/run-2-summary.json)
- [Run 3 原始（有效）](startup-stp-2026-10-16/run-3.json.gz) / [摘要](startup-stp-2026-10-16/run-3-summary.json)
- [Run 4 原始（有效）](startup-stp-2026-10-16/run-4.json.gz) / [摘要](startup-stp-2026-10-16/run-4-summary.json)

摘要重算：`node scripts/analyze-startup-profile.mjs docs/benchmarks/startup-stp-2026-10-16/run-3.json.gz`。

测试页面会向 `http://127.0.0.1:5175/report` POST JSON，同时保留 `window.__startupReport`；此次使用临时本机收集器接收，报告已保存后停止收集器。测试用包装仅存在于该测试页面，不影响正常首页。
