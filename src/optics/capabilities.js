import { normalizeDiffraction } from './diffractive.js';
import { normalizeAsphere, firstOrder, apertureLimits, paraxialSensorZ, rearSamplingRegion } from './lens-state.js';

const F32_MIN_NORMAL = 1.1754943508222875e-38;

/** Static acceptance for the *current* 224-byte r183/WebGPU optical ABI.
 * This deliberately does not claim successful ray traversal or GPU validation.
 * Uses the same scalar setup as packLens, but never allocates glass LUTs.
 */
export function preflightLens(lens, options = {}) {
  const { sensorMm = [36, 24] } = options;
  // The supplied configuration's final thickness is authoritative. Finite
  // native conjugates may include sensor cover glass and cannot be moved to an
  // arbitrary 20 m paraxial focus without crossing that fixed rear structure.
  // Only an explicitly requested focus override uses a paraxial sensor estimate.
  const focusOverride = Object.hasOwn(options, 'focusDistanceM');
  const focusDistanceM = focusOverride ? options.focusDistanceM : lens.objectDistanceMm === null ? null : lens.objectDistanceMm / 1000;
  const warnings = [];
  const result = { parserSupported: true, supported: false, gpuValidated: false,
    validation: 'static-preflight-only', initialFocusDistanceM: focusDistanceM,
    initialization: focusOverride ? 'explicit-paraxial-focus-override' : 'native-prescribed-image-plane', warnings };
  try {
    if (!lens.surfaces?.length) throw new Error('没有可用的轴对称折射面');
    if (!Number.isInteger(lens.stopIndex) || !lens.surfaces[lens.stopIndex]) throw new Error('光阑索引无效');
    if (sensorMm.length !== 2 || !sensorMm.every(v => Number.isFinite(v) && v > 0)) throw new Error('传感器尺寸无效');
    if (focusDistanceM !== null && !(Number.isFinite(focusDistanceM) && focusDistanceM > 0)) throw new Error('初始对焦物距无效');
    const f32 = (value, label) => {
      const packed = Math.fround(value);
      if (!Number.isFinite(packed) || Math.abs(packed) >= 1e30 || (value !== 0 && Math.abs(packed) < F32_MIN_NORMAL)) {
        throw new Error(`${label} 无法由当前 f32 光学内核表示`);
      }
      return packed;
    };
    for (const [index, s] of lens.surfaces.entries()) {
      if (!['plane', 'sphere', 'conic', 'even-asphere', 'extended-odd-asphere', 'diffractive'].includes(s.type)) throw new Error(`S${index + 1}: 未支持的面型 ${s.type}`);
      if (s.index !== index || !lens.glasses[s.mediumBefore] || !lens.glasses[s.mediumAfter]) throw new Error(`S${index + 1}: 面索引或介质引用无效`);
      for (const field of ['zMm', 'radiusMm', 'conic', 'thicknessMm']) f32(s[field], `S${index + 1}.${field}`);
      if (s.apertureRadiusMm !== null) {
        if (!(s.apertureRadiusMm > 0)) throw new Error(`S${index + 1}: 物理半口径无效`);
        f32(s.apertureRadiusMm, `S${index + 1} 物理半口径`);
      }
      if (index > 0 && s.zMm > lens.surfaces[index - 1].zMm && Math.fround(s.zMm) <= Math.fround(lens.surfaces[index - 1].zMm)) {
        throw new Error(`S${index + 1}: 正轴向间距在 f32 打包后消失`);
      }
      const normalized = normalizeAsphere(s);
      if(s.type==='diffractive'&&!s.doe)throw new Error(`S${index+1}: missing DOE phase prescription`);
      normalizeDiffraction(s,normalized.scaleMm);
      f32(normalized.numericalRadiusMm, `S${index + 1} 求交域`);
      // WGSL computes c*c and scale*scale before applying these factors.
      if (s.radiusMm !== 0) f32(Math.fround(1 / Math.fround(s.radiusMm)) ** 2, `S${index + 1} 曲率平方`);
      f32(normalized.scaleMm ** 2, `S${index + 1} 非球面径向尺度平方`);
    }
    if (lens.surfaces[0].mediumBefore !== 'air' || lens.surfaces.at(-1).mediumAfter !== 'air') throw new Error('当前相机权重要求物方及像方为空气');
    const paraxial = firstOrder(lens), limits = apertureLimits(lens);
    for (const [field, value] of Object.entries(paraxial)) if (!Number.isFinite(value)) throw new Error(`近轴参数 ${field} 退化`);
    for (const field of ['minFNumber', 'maxFNumber', 'maxStopRadiusMm']) if (!(Number.isFinite(limits[field]) && limits[field] > 0)) throw new Error(`光圈参数 ${field} 无效`);
    const fNumber = Math.max(limits.minFNumber, 2.8);
    if (fNumber > limits.maxFNumber) throw new Error('初始光圈超出数据约束');
    const sensorZMm = focusOverride ? paraxialSensorZ(lens, focusDistanceM) : lens.sensorZMm;
    const region = rearSamplingRegion(lens, sensorZMm, sensorMm);
    const stopRadiusMm = Math.abs(limits.focalLengthMm * limits.pupilMagnification) / (2 * fNumber);
    for (const [field, value] of Object.entries({ sensorZMm, stopRadiusMm, radiusMm: region.radiusMm, areaPdf: region.areaPdf })) f32(value, field);
    if (!(region.radiusMm > 0 && region.areaPdf > 0 && stopRadiusMm > 0)) throw new Error('后部采样区域或光阑退化');
    const extent = lens.metadata?.fieldExtent;
    if (lens.metadata?.fieldMode === 'height' && Number.isFinite(extent) && extent > 0 && extent < Math.hypot(...sensorMm) / 2 - .01) {
      warnings.push(`上游声明最大像高 ${extent} mm，小于 ${sensorMm.join('×')} mm 传感器半对角线；该记录未提供完整画幅像圈保证。`);
    }
    if (!lens.apertureDataComplete) warnings.push('通光数据不完整：只对处方已知物理口径和已标定光阑计算遮挡，未知通光面采用数值求交域；该域不是已知物理通光范围。');
    if (region.unknownAperture) warnings.push('后面通光未知：后部包围区域只在已声明有限数值域内保守，不保证未知物理区域的全部通路。');
    warnings.push('此配置通过静态打包、近轴与采样域预检，尚不代表逐镜头 GPU 成像或所有物距/光圈已验证。');
    return { ...result, supported: true, reason: null, initialSensorZMm: sensorZMm,
      initial: { fNumber, sensorZMm, imageDistanceMm: sensorZMm - lens.lastVertexZMm, stopRadiusMm,
        focalLengthMm: paraxial.focalLengthMm, samplingRadiusMm: region.radiusMm, samplingAreaPdf: region.areaPdf } };
  } catch (error) {
    return { ...result, reason: error.message };
  }
}
