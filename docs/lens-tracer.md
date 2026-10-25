# 可嵌入镜头追迹器（lens-tracer）

`src/lens-tracer.js`（包入口 `lens-sim`）把真实镜组追迹、BVH 求交、光谱累计封装成不依赖 DOM、`window` 与渲染框架的模块。lens-sim 应用本身也通过它运行（`hybrid-runtime.js`），没有第二条代码路径。

```js
import { createLensTracer, requiredLimits, createLensLibrary } from 'lens-sim';

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice({ requiredLimits: requiredLimits(adapter.limits, { provider }) });
const tracer = await createLensTracer({ device, provider, width: 1920, sensorMm: [36, 24],
  outputFormat: 'rgba16float', workers: { bvh, pupil, focus } });
const library = createLensLibrary({ baseUrl: '/static/lenses/' });   // 或 { manifest, assets } 预加载
await tracer.setLens(await library.prescription('canon-fl-50mm-f1-8'), { fNumber: 2.8, dispersion: true });
tracer.setPose(cameraToWorld);          // 列主序 4×4，世界坐标米
await tracer.setScene(sceneSource);     // 表面类提供者需要
await tracer.autofocus();               // 或 tracer.focus(distanceM)
await tracer.render({ targetSpp: 256 });
const hdr = await tracer.readHDR();     // { width, height, spp, data: Float32Array RGBA 线性 sRGB }；space: 'xyz' 时 A 为尝试路径数
```

| 接口 | 说明 |
| --- | --- |
| `createLensTracer({ device \| interop, provider, width, sensorMm, outputFormat, workers, memoryBudget, scene, … })` | `interop` 来自 `createThreeInterop(renderer)`（three 适配，输出图为 StorageTexture）；否则用原始 `GPUDevice`。`workers.*`：省略 = 打包的模块 Worker，`false` = 主线程内联，`() => Worker` = 宿主提供。 |
| `requiredLimits(adapter.limits, { provider })` | 宿主 `requestDevice` 时请求的限额；按提供者的每阶段资源检查（`gpu-policy.js`）。 |
| `setLens(prescription, { fNumber, sensorZMm, sensorMm, dispersion, pupilSampling })` | 传感器长宽比与图像一致（宽为 3 的倍数、高为偶数）。 |
| `updateOptics(patch)`、`focus(distanceM, { trim })`、`autofocus()`、`referenceTarget()` | 与 lens-sim 相同的对焦搜索（对焦表 / 移动镜组 / 传感器的 RMS 搜索；无镜组数据的镜头再按轴上 MTF 微调像面，`trim` 可指定其它方法也微调，如 `FOCUS_METHODS` 全部微调，见 [lens-data.md](lens-data.md#focus-criterion)），保持物理光阑半径。 |
| `setPose(m)`、`setOrigin([x,y,z])` | 原点以 f64 从位姿与全部实例变换中减去（远离原点的世界保持相机附近 f32 精度）；提供者收到的是重定心后的坐标。 |
| `setScene(source)`、`setRadianceProvider(provider)` | 场景源见下；提供者可在运行中替换（编译完成前旧提供者继续工作）。 |
| `sample(opts)`、`render({ targetSpp })`、`reset()`、`resize(w)`、`statistics()`、`readHDR()` | `outputTexture` 为显示用的钳制线性图（`outputFormat`）；`readHDR` 不钳制、不半精度。 |
| `frontElement()`、`exitFootprint({ fields, samples })` | 镜头空间（mm）前组几何与光线实际出射区域（CPU 反向追迹）。 |
| `rayBatch(opts)`、`renderCached(opts)` | 光线缓存（下节）。 |

## 辐亮度提供者（radiance provider）

引擎占用绑定 0–23；提供者从 `PROVIDER_BINDING_BASE`（24）起声明自己的资源（`radiance-provider.js`）：

```js
{ kind: 'surface' | 'ray', label, wgsl(base) -> string, bindings(base) -> GPUBindGroupEntry[],
  revision /* 资源变化时改变 */, ready, resources: { storageBuffers, uniformBuffers, sampledTextures, samplers, storageTextures } }
```

* `surface`：镜头批次 → BVH 求交 → 着色。WGSL 定义 `sceneShade(s: SceneSurface, wo, key) -> SceneShade` 与 `sceneEnvironmentRadiance(d)`；引擎负责交点重建与最多 6 层透明合成（`scene-surface.wgsl`）。庭院 PBR 移植是 1 号提供者（`garden-provider.js`：材质/星表 + 光栅光照桥接）。
* `ray`：没有求交阶段，也不需要 BVH。WGSL 定义 `rayRadiance(ray: LensRay) -> RayRadiance`，`LensRay { origin, lambda, direction, weight, key }` 中 origin 即前组出射点（`ray-radiance.wgsl`）。`flags` 可标记“参考数据之外”（计入 reflectionOutside 诊断）与透明层数。
* `createConstantRayProvider(rgb)`：无资源的白炉模板；`createSurfaceRayProvider({ provider, scene })`：把表面提供者包装成逐光线自行求交的光线提供者，用于以今天的输出验证光线缓存。
* 声明的每个绑定都必须在 WGSL 中静态使用（自动布局）。

## 场景源（scene source）

与 three 材质无关的输入（`scene/scene-source.js`）：每个 BLAS 一组 `positions`（及可选 `indices`（Uint16/Uint32）、`normals`、`uvs`、`colors`（rgb/rgba）、`primitiveIds`）与稳定的 `key`；实例记录 `{ blas, matrixWorld, count, instanceMatrices, colors, material, flags }`。只含 `{ key }` 的条目复用上次发送的数组（只重建 TLAS）。`alphaMask` 字段已预留，尚未实现（任意命中）。lens-sim 的 `extractScene` 是生产者之一（结果的 `source`）。构建在 Worker（或内联）中进行：`scene-builder.js`。

实测（Node，本机）：128 万唯一三角形的索引地形 + 10 万实例叶片：BLAS 2.5 s、TLAS 0.4 s，总 3.1 s；GPU 缓冲 149 MiB（`tests/scene-source.test.mjs` 打印）。

## 光线缓存（ray cache）

供光线提供者使用：镜头侧先把 S spp 的光学样本留在 GPU，按前组出射点分格，宿主每格渲染一个视图，只解析该格光线，最后按直接路径完全相同的规则累计每一次尝试（`ray-cache.js`）。

```js
const batch = await tracer.rayBatch({ spp: 16, targetSpp: 256, grid: 4, memoryBytes: 512 * 2 ** 20 });
for (const cell of batch.cells) if (cell.count) {
  renderViewFrom(cell.originWorld, cell.directionMin, cell.directionMax);  // 宿主：更新提供者资源
  batch.resolve(cell.index);
}
const stats = batch.finish();  // { spp, rays, renders, cells, raysPerCell, maxParallaxResidualMm }
// 或：await tracer.renderCached({ targetSpp, grid, renderCell: async (cell, batch) => { … } })
```

* 缓存无量化：直接保留分阶段的镜头包（每个正象限像素/样本 48 字节，由 4 条镜像光线共用，即每光线 12 字节），另加每光线 4 字节排序索引和 8 字节结果（f32 波长处光谱辐亮度 + 状态位）。光学失败不进入分格，累计阶段照常计为尝试。
* 分格：出射圆盘（半径取 `exitFootprint` 的实际出射范围）上 n×n 网格，每批旋转并亚格抖动，格界不固定。GPU 上工作组直方图 → 前缀和 → 工作组内槽位散射；每格记录光线数、范围、定点质心、出射边界与镜头空间方向边界。
* `memoryBytes` 决定 S：优先整块（tile）一次覆盖，放不下时减小 S，S=1 仍放不下则按包组拆成多批。
* 解析核心与直接路径使用同一世界光线、同一随机键和同一光谱贡献表达式；GPU 测试 `tests/lens-tracer-gpu.html` 在庭院场景上比较“分阶段表面路径 / 包装 BVH 的光线路径 / 光线缓存路径”。

## 其它嵌入要点

* WGSL 以 `.wgsl` 为源，`scripts/build-wgsl.mjs` 生成同名 `.wgsl.js` 字符串模块（git 忽略；`prepare`/`predev`/`prebuild`/`pretest` 自动生成；Vite 开发服务器直接读取 `.wgsl`）。webpack/Next、Node 与 Worker 均可直接导入。
* Worker 采用 `new Worker(new URL('./x.js', import.meta.url), { type: 'module' })` 字面量形式（Vite、webpack 5 可识别），也可注入或关闭。
* 镜头数据：`node scripts/build-lens-data.mjs --out <dir>`；清单中的资源路径相对清单本身。
* `package.json` `exports`：`.`（追迹器）、`./three`（three 适配与补丁）、`./garden-provider`、`./lighting`、`./radiance-provider`、`./scene-source`、`./scene-extract`、`./lens-library`、`./workers/*`；three 为 peerDependency。
