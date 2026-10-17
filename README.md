# lens-sim

基于 WebGPU 和 Three.js 的光学渲染实验项目，使用真实镜组处方进行光线追迹与光谱采样，以程序化三维场景演示成像效果。

支持镜头切换、光圈与对焦调整、镜组编辑、图片导出、昼夜光照和 HDR 输出。项目仍处于实验阶段，物理模型与数据覆盖存在限制，详见 [技术文档](docs/README.md)。

## 运行

需要 Node.js 22+ 和支持 WebGPU 的浏览器。

```sh
git submodule update --init --recursive
npm ci
npm run dev
```

打开终端显示的本地地址。

## 基本操作

- 左键拖动环视，右键拖动平移，滚轮缩放。
- W A S D 移动，Q / E 下降或上升。
- F 自动对焦，L 打开镜组工作台，P 打开性能诊断。
- 在镜头面板切换光栅视图与镜头追迹，调整拍摄参数并保存图片。

## 构建与测试

```sh
npm test
npm run build
npm run preview
```

构建输出位于 `dist/`。浏览器验证默认使用 Safari Technology Preview，具体方法见 [验证说明](docs/README.md#复现验证)。

## 数据与文档

镜头数据及部分解析代码来自 [anvcor/lens-bench](https://github.com/anvcor/lens-bench)。上游许可证为 GPL-3.0，来源与适配说明见 [镜头数据文档](docs/lens-data.md)。镜头数据在运行和构建时自动生成，无需手动提交生成文件。

算法、架构和已知限制见 [文档索引](docs/README.md)。
