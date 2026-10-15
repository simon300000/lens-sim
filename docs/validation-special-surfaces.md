# XODD、DOE 与原生像面间距验收

2026-10-15。实现保留在独立分支 `codex/special-surfaces-integration`，**未合入 main、未 push、未部署**。基线为 `a165907`；主工作区已有的相机控制与瞳孔采样改动未纳入此分支。两名实现 agent 均使用 GPT-6.1 Sol，各自在独立 worktree 实现并使用 Safari Technology Preview 验证；父任务只在第三个集成 worktree 组合与复验。

## 静态目录结果

上游仍固定为 `8274ca9d34bf75611f5a3c00af54a6a8498f076b`，没有修改上游镜头数据。

| 项目 | 原状态 | 此分支 |
| --- | ---: | ---: |
| 镜头总数 | 458 | 458 |
| 静态可用镜头 | 420 | 455 |
| 静态可用配置 | 1820 | 1967 |
| 完全不可用镜头 | 38 | 3 |

24 款 XODD 的 102 个配置、7 款 DOE 的 28 个配置均可用。取消固定原生像面最小间距后，另外恢复 4 款原本可解析镜头的 17 个配置；同时支持 4 款 XODD 镜头的 19 个原生小间距配置。后者已计入 XODD 数量，不重复计数。

剩余不可用项是 Leica APO-Summicron-M 75mm F2 ASPH、Sony FE 16mm F1.8 G（共 8 个配置触及保守后表面包络），以及 Nikon Z 50mm F1.2 S（4 个配置含负轴向厚度）。这些限制未用删项、改口径或移动原生像面来绕过。所有生成记录的 `gpuValidated` 仍为 false；下述路径/诊断测试不等同于全目录逐镜头视觉成像验收。

## 实现

- XODD 保留原始 Rn 和 A1–A28，CPU 矢高/法线使用源 f64；GPU 转为 Bernstein 系数并用 de Casteljau 求值，避免大系数抵消后的 f32 精度损失。转换误差受检，A2 进入近轴曲率；A1 非零的轴心尖点仍拒绝相机初始化。
- DOE 保留原始阶次、归一化半径和相位，按指定阶次相位梯度计算波长相关的切向动量变化，并支持反向互易和近轴光焦度。几何载体与其非球面项不被替换。源数据未提供的衍射效率、阶次分裂和相干干涉不模拟。
- 共用 224 字节表面 ABI，包含 28 个矢高基系数、编码、12 个 DOE 相位系数；`packOpticalSurfaces` 供生产和 GPU 探针共用。联合载体测试同时验证 XODD 曲率和 DOE 光焦度不会互相覆盖。
- 原生零间距/短间距平面盖玻璃采用完整后向余弦半球，保留传感器位置和 t=0 界面折射。角度 PDF 为 cosθ/π，校准后单次权重为 4；不补采失败光线，不按成功数归一化。0.05 mm 只选择采样参数化，不再是可用性限制。
- 同一条光线的保守区间细分可证明完整已知口径内无交点；未知或截断域、未解决切线仍报告数值诊断。源 f64 区间缓存随系数、Rn 和尺度变化失效。GPU 圆锥项的误差保护随 q 的条件数变化，不扩大物理口径。

## 集成验收

本机 Safari Technology Preview，原生 WebGPU；以下最终集成页面均在可见且有焦点时运行，未清浏览器缓存，无跨设备或性能结论。

| 验收 | 结果 |
| --- | --- |
| `npm test` | 144/144 通过 |
| `npm run build` | 通过 |
| `catalog-new-forms-gpu.html` | 全部 31 款、130 配置产生有限正信号；固定尝试预算正确，无 GPU 验证错误。仅保留下述独立核对的未知域诊断 |
| `native-gap-gpu.html` | 8 款、36 配置，7,077,888 次尝试；全部保留原生像面、零数值/GPU 错误、有限正信号 |
| 原生零间距能量对照 | Hasselblad XCD 65mm，GPU 与独立 f64 均 5176 条有效；相对 Y 误差 8.45e-8 |
| `hybrid-optics.html` | 77 组、2794 条生产内核光路探针通过，包含 XODD/DOE/轴心/互易；批次前缀误差 0，扩大采样域的能量比 0.9999069 |
| `runtime-gpu.html` | 镜头切换、原生零间距、手动 0/0.026 mm、失败调焦保留状态、AF、生命周期及缓冲检查通过 |

原始结果保留在本 worktree 的 `artifacts/integration-*_html.json`，Node/build 日志为 `artifacts/integration-node.log`、`artifacts/integration-build.log`。GPU 新测试已加入 `scripts/run-gpu-tests.mjs` 默认列表；本次浏览器验证实际使用 Safari，而非该脚本的 Chromium 后端。

## 独立验证和数值边界

XODD agent 的提交为 `23c1fb1`、`11aa738`、`f35fb6d`、`e65d586`；原生诊断工具为 `6a29ac2`。83 个非小间距配置共 4,079,616 条整幅光线，CPU/GPU 状态逐条一致，最大位置误差 4.97e-5 mm、方向误差 2.05e-6，未放宽 1e-3 mm / 2e-5 的探针容限。74074 个源公式/f32 密集点的最大矢高误差 2.41e-6 mm、斜率误差 3.13e-6，最大源 f64 基转换误差界 3.98e-9 mm。报告为 `artifacts/xodd-fullframe-bernstein-safari-stp.json`。

另 19 个原生配置独立检查了 3,735,552 条光线，零数值/GPU 错误。严格状态一致性报告 `artifacts/xodd-native19-conditioned-safari-stp.json` **保留 passed=false**：GF30 cfg3 和 XF60 cfg5 各有一条位于物理光阑边缘的 f32/f64 分类差异。前者位置差 2.38e-5 mm；后者落在既有 GPU 口径误差保护范围内。匹配路径位置/方向误差仍在原容限内。未为此扩大口径或修改容差；具体点、半径、内外边距及原生 t=0 参考约定见 `artifacts/xodd-native19-boundary-audit.json`。父任务的 36 配置测试验证实际渲染、能量及数值错误，不把它伪称为逐光线状态完全一致。

Nikon AF-S 35mm F1.4G 的 S12 没有真实通光口径，k=194、R=-224.2964 mm，其圆锥主支半径约 16.0622 mm，小于声明的 100 mm 数值域。整幅固定样本中 cfg0/1/2 分别保留 21/22/11 条数值诊断，cfg3 为 0。集成测试逐像素独立 f64 重放，核对每一个 GPU 数值计数均来自未知/截断域；没有将它们改记为物理遮挡。这不是 XODD 面型不支持，也不是全通光数据已补全。

DOE agent 提交为 `e3ef181`，吞吐诊断为 `d65fc75`。672 条独立上游透射路径最大误差 4.89e-10 mm / 1.20e-12 方向；Safari 独立检查 71 组、2638 条路径，零 GPU 错误，全部 28 个 DOE 配置均保留实际相位及波长效应。报告为 `artifacts/doe-agent-safari-stp.json`。

Nikon Z 600mm F4 的有效后向区域很窄。固定 32 spp 时 0/49152 有效、图像为黑；同一序列 1024 spp 时四个配置均为 17/1572864 有效，CPU/GPU 一致且无数值错误，Y=0.03666958。集成目录检查对此使用固定 1024 spp。这只能证明有信号，**不代表图像已收敛**；参见 [吞吐诊断](doe-throughput.md)。本分支不吸收另一个正在进行的瞳孔重要性采样工作。

## 复现

运行 `npm run build:lenses`、`npm test` 和 `npm run build`。通过本地 Vite 在 Safari Technology Preview 打开上表页面；`hybrid-optics.html` 加 `?lens=canon-fl-50mm-f1-8`。

独立原生逐光线诊断先运行 `node scripts/prepare-xodd-native-fixtures.mjs`，再打开 `tests/xodd-field-gpu.html?native`。它保留严格边缘差异，不替代生产引擎的 `native-gap-gpu.html`。长焦固定前缀诊断可打开 `tests/doe-throughput-gpu.html` 或执行 `node scripts/diagnose-doe-throughput.mjs 32` / `1024`。
