# 技术文档

- [光学数学与采样测度](optics-math.md)
- [光谱模型与来源](spectral.md)
- [出瞳重要性采样](pupil-sampling.md)
- [场景查询与实时光照](scene-query.md)
- [镜头数据、来源与更新](lens-data.md)
- [能力预检与失败采样审计](lens-capabilities.md)
- [默认镜头选择](default-lens-recommendation.md)
- [DOE 通光诊断](doe-throughput.md)

## 复现验证

`npm ci` 后运行 `npm test` 和 `npm run build`。先初始化 `vendor/lens-bench` submodule；镜头数据由构建脚本生成。

浏览器功能、WebGPU、成像与性能验证默认使用 Safari Technology Preview，在独立前台标签页中访问 `tests/` 下的 HTML 测试页。保留原有标签页，完成后只关闭测试创建的标签页。性能记录需分开报告预计算、编译和正式渲染时间；后台、中断或 GPU 错误运行不可作为性能结论。

`scripts/run-gpu-tests.mjs` 与 `scripts/app-smoke.mjs` 是补充的 Playwright Chromium 自动化工具。先运行 `npm install --no-save playwright` 和 `npx playwright install chromium`，再执行脚本；也可通过 `PLAYWRIGHT_MODULE` 指定模块。SwiftShader 的结果只表示软件适配器，不能代替硬件 GPU 性能。

本机实验输出使用被忽略的 `artifacts/`；`docs/benchmarks/` 也被忽略，以免原始结果再次进入提交。
