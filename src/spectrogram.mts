import { DateTime } from "luxon";
import { SeismogramDisplayData } from "./seismogram.mjs";
import { Seismograph } from "./seismograph.mjs";
import { fftForward } from "./fft.mjs";
import { SeismographConfig } from "./seismographconfig.mjs";
import { clearCanvas } from "./seismographutil.mjs";

export type WindowFunctionType =
  | "hann"
  | "hamming"
  | "blackman"
  | "rectangular";
const SPECTROGRAM_ELEMENT = "sp-spectrogram";

export class SpectrogramConfig extends SeismographConfig {
  // Number of time samples in each FFT frame
  fftSize: number = 2048;
  // Number of samples to overlap (e.g., 512).
  overlap: number = 1594;
  // Minimum time window for each spectrogram slice in seconds - ideally, resulting chunk times will be near this value
  minChunkTime: number = 0;
  // Type of window function to apply
  windowType: WindowFunctionType = "hann";
  // Frequency range for the spectrogram display in Hz - cannot exceed Nyquist frequency (sampleRate / 2)
  freqMin: number = 0;
  freqMax: number = 15;
  // Lower and upper bounds for spectrogram color scaling in decibels.
  // FFT power values below minDb are shown as the darkest color,
  // and values above maxDb are shown as the brightest color.
  minDb: number = 30;
  maxDb: number = 150;
  // Color map for spectrogram display
  spectrogramColorMap: ColorMapName = "jet";

  constructor() {
    super();
  }
}

export class Spectrogram extends Seismograph {
  spectrogramConfig: SpectrogramConfig;

  constructor(seisData?: SeismogramDisplayData | SeismogramDisplayData[], seisConfig?: SpectrogramConfig) {
    super(seisData, seisConfig);
    this.spectrogramConfig = seisConfig || new SpectrogramConfig();
  }

  override drawSeismograms() {
    if (!this.isVisible()) {
      // no need to draw if we are not visible
      return;
    }
    const canvas = this.canvas?.node();
    if (!canvas)
      return;
    clearCanvas(canvas);

    const fullSeisDataUnformatted: number[] = [];
    let dataSampleRate;
    this._seisDataList.forEach((sdd, i) => {
      const xScale = this.timeScaleForSeisDisplayData(sdd, true);
      // const yScale = this.ampScaleForSeisDisplayData(sdd);
      const s = xScale.domain().start?.valueOf();
      const e = xScale.domain().end?.valueOf();
      if (s == null || e == null || s === e) {
        return;
      }

      const seismogram = sdd.seismogram;
      if (!seismogram) {
        return;
      }

      dataSampleRate = seismogram.sampleRate;
      fullSeisDataUnformatted.push(...seismogram.y);
    });

    if (dataSampleRate == null)
      return;

    const fullSeisData = new Float32Array(fullSeisDataUnformatted);
    const durationSec = fullSeisData.length / dataSampleRate;

    // TODO: Do we use durationSec here instead of canvasWidth? durationSec seems to give a much more accurate representation
    // of the time window, although it slows down the rendering quite a bit
    const spectrogram = new SpectrogramWeb(
      this.spectrogramConfig,
      dataSampleRate,
      canvas.width,
    );
    spectrogram.setData(fullSeisData);

    const duration = spectrogram.getDuration();
    const windowSize = durationSec;

    const end = Math.max(0.001, duration);
    const start = end - windowSize;

    spectrogram.render({
      canvas: canvas,
      width: canvas.width,
      height: canvas.height,
      timeRange: [start, end],
      freqRange: [this.spectrogramConfig.freqMin, this.spectrogramConfig.freqMax],
    }).catch(() => {
      return;
    });
  }
}
customElements.define(SPECTROGRAM_ELEMENT, Spectrogram);

export interface RenderOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  timeRange: [number, number]; // [startTime, endTime]
  freqRange: [number, number]; // [minFreq, maxFreq]
}

class SpectrogramWeb {
  private model: SpectrogramModel;
  private renderer: CanvasRenderer;

  constructor(
    config: SpectrogramConfig,
    sampleRate: number,
    windowSize: number,
  ) {
    this.model = new SpectrogramModel(config, sampleRate);
    this.renderer = new CanvasRenderer(this.model, windowSize);
  }

  setData(data: Float32Array) {
    this.model.setData(data);
    this.renderer.clearCache();
  }

  destroy() {
    this.renderer.dispose();
  }

  async render(options: RenderOptions) {
    // Default freq range to [0, Nyquist] if not provided
    const nyquist = this.model.sampleRate / 2;
    const freqRange: [number, number] = [0, nyquist];
    if (this.model.config.freqMin !== undefined)
      freqRange[0] = this.model.config.freqMin;
    if (this.model.config.freqMax !== undefined)
      freqRange[1] = this.model.config.freqMax;

    if (freqRange[0] < 0 || freqRange[1] > nyquist) {
      // Frequency range is out of bounds. Adjusting to valid range
      freqRange[0] = Math.max(freqRange[0], 0);
      freqRange[1] = Math.min(freqRange[1], nyquist);
    }

    await this.renderer.render(options, freqRange);
  }

  updateConfig(config: Partial<SpectrogramConfig>) {
    this.model.updateConfig(config);
    if (
      config.fftSize ||
      config.overlap ||
      config.minChunkTime ||
      config.windowType ||
      config.freqMin ||
      config.freqMax ||
      config.minDb ||
      config.maxDb ||
      config.spectrogramColorMap ||
      config.margin?.left ||
      config.margin?.top ||
      config.margin?.right ||
      config.margin?.bottom
    ) {
      this.renderer.clearCache();
    }
  }

  getDuration(): number {
    return this.model.getDuration();
  }
}

export class SpectrogramModel {
  config: SpectrogramConfig;
  sampleRate: number;
  data: Float32Array | null = null;

  showRealTimeScale: boolean = false;
  startTime: number = 0;

  constructor(config: SpectrogramConfig, sampleRate: number) {
    this.config = config;
    this.sampleRate = sampleRate;
  }

  setData(data: Float32Array) {
    // Taken from branch where isTimestamped is false because we don't do that here
    this.data = data;
    this.startTime = 0;
  }

  updateConfig(newConfig: Partial<SpectrogramConfig>) {
    Object.assign(this.config, newConfig);
  }

  getDuration(): number {
    return this.data ? this.data.length / this.sampleRate : 0;
  }
}

export class CanvasRenderer {
  private model: SpectrogramModel;
  private processor: ChunkProcessor;
  private windowSize: number;

  private chunks: Map<string, DataChunk> = new Map();
  private offscreenHelpers: Map<string, ImageBitmap> = new Map();

  constructor(model: SpectrogramModel, windowSize: number) {
    this.model = model;
    this.windowSize = windowSize;
    this.processor = new ChunkProcessor(
      model.config,
      this.model.sampleRate,
      windowSize,
    );
  }

  clearCache() {
    this.chunks.clear();
    this.offscreenHelpers.clear();
  }

  dispose() {
    this.clearCache();
  }

  private setupHiDPICanvas(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: true })!;

    return ctx;
  }

  private calibrateCanvas(canvas: HTMLCanvasElement) {
    return this.setupHiDPICanvas(canvas);
  }

  async render(options: RenderOptions, freqRange: [number, number]) {
    const { canvas, timeRange } = options;
    const ctx = this.calibrateCanvas(canvas);
    if (!ctx) {
      return;
    }

    const width = canvas.width;
    const height = canvas.height;
    const [tStart, tEnd] = timeRange;
    const [fMin, fMax] = freqRange;

    const plotX = this.model.config.margin.left;
    const plotY = this.model.config.margin.top;
    const plotW =
      width - this.model.config.margin.left - this.model.config.margin.right;
    const plotH =
      height - this.model.config.margin.bottom - this.model.config.margin.top;

    const colorMap = new ColorMap(this.model.config.spectrogramColorMap);

    ctx.clearRect(0, 0, width, height);

    if (!this.model.data) {
      return;
    }

    const sampleRate = this.model.sampleRate;
    const config = this.model.config;
    const hopSize = Math.max(1, this.windowSize - config.overlap);

    const targetSamples = this.model.config.minChunkTime * sampleRate;
    const hopsPerChunk = Math.ceil(targetSamples / hopSize);
    const chunkSamples = hopsPerChunk * hopSize;

    const viewStartIdx = Math.floor(Math.max(0, tStart * sampleRate));
    const viewEndIdx = Math.floor(
      Math.min(this.model.data.length, tEnd * sampleRate),
    );
    if (viewEndIdx <= viewStartIdx) {
      return;
    }

    const startChunkId = Math.floor(viewStartIdx / chunkSamples);
    const endChunkId = Math.floor(viewEndIdx / chunkSamples);

    for (let i = startChunkId; i <= endChunkId; i++) {
      const chunkStart = i * chunkSamples;
      const chunkEnd = Math.min((i + 1) * chunkSamples, this.model.data.length);
      const chunkId = `chunk_${i}`;

      let chunk = this.chunks.get(chunkId);

      if (!chunk) {
        const newChunk = new DataChunk(
          chunkId,
          chunkStart,
          chunkEnd,
          sampleRate,
        );
        this.chunks.set(chunkId, newChunk);

        const imgData = this.processor.process(
          this.model.data,
          chunkStart,
          chunkEnd,
          config,
          (val: number) => colorMap.getRGB(val),
        );

        const bmp = await createImageBitmap(imgData);
        newChunk.image = bmp;

        chunk = newChunk;
      }

      if (chunk.image && ctx) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(plotX, plotY, plotW, plotH);
        ctx.clip();

        this.drawChunk(
          ctx,
          chunk,
          tStart,
          tEnd,
          fMin,
          fMax,
          plotX,
          plotY,
          plotW,
          plotH,
        );

        ctx.restore();
      }
    }
  }

  private drawChunk(
    ctx: CanvasRenderingContext2D,
    chunk: DataChunk,
    viewTStart: number,
    viewTEnd: number,
    fMin: number, // Hz
    fMax: number, // Hz
    plotX: number,
    plotY: number,
    plotW: number,
    plotH: number,
  ) {
    if (!chunk.image) {
      return;
    }

    const viewDuration = viewTEnd - viewTStart;
    const sampleRate = this.model.sampleRate;
    const nyquist = sampleRate / 2;

    const chunkStartTime = chunk.startIndex / sampleRate;
    const chunkEndTime = chunk.endIndex / sampleRate;

    const x1 = plotX + ((chunkStartTime - viewTStart) / viewDuration) * plotW;
    const x2 = plotX + ((chunkEndTime - viewTStart) / viewDuration) * plotW;

    if (x2 <= plotX || x1 >= plotX + plotW) {
      return;
    }

    const dx = Math.max(plotX, x1);
    const dw = Math.min(plotX + plotW, x2) - dx;

    const texW = chunk.image.width;
    const sx = ((dx - x1) / (x2 - x1)) * texW;
    const sw = (dw / (x2 - x1)) * texW;

    const safeFMax = Math.min(fMax, nyquist);
    const safeFMin = Math.max(fMin, 0);

    const texH = chunk.image.height;
    const sy_top = (1 - safeFMax / nyquist) * texH;
    const sy_bottom = (1 - safeFMin / nyquist) * texH;
    const sy_h = sy_bottom - sy_top;

    if (sy_h > 0) {
      const dy = plotY;
      const dh = plotH;

      ctx.drawImage(chunk.image, sx, sy_top, sw, sy_h, dx, dy, dw, dh);
    }
  }
}

export class DataChunk {
  public id: string;
  public startTime: number;
  public endTime: number;
  public startIndex: number;
  public endIndex: number;

  public image: ImageBitmap | null = null;
  public isProcessing: boolean = false;

  constructor(
    id: string,
    startIdx: number,
    endIdx: number,
    sampleRate: number,
  ) {
    this.id = id;
    this.startIndex = startIdx;
    this.endIndex = endIdx;
    this.startTime = startIdx / sampleRate;
    this.endTime = endIdx / sampleRate;
  }
}

export class ChunkProcessor {
  private windowBuffer: Float32Array;
  private inputBuf: Float32Array;
  private fftSize: number;
  private sampleRate: number;

  constructor(
    config: SpectrogramConfig,
    sampleRate: number,
    windowSize: number,
  ) {
    this.fftSize = config.fftSize;
    this.windowBuffer = createWindow(windowSize, config.windowType);
    this.inputBuf = new Float32Array(this.fftSize);
    this.sampleRate = sampleRate;
  }

  process(
    data: Float32Array,
    startIdx: number,
    endIdx: number,
    config: SpectrogramConfig,
    colormapToRgb: (normalizedVal: number) => [number, number, number],
  ): ImageData {
    const { minDb, maxDb, overlap } = config;
    const windowSize = this.windowBuffer.length;
    const hopSize = Math.max(1, windowSize - overlap);

    const numHops = Math.ceil((endIdx - startIdx) / hopSize);
    const width = numHops;
    const height = (this.fftSize >> 1) + 1;

    if (width <= 0) {
      return new ImageData(1, 1);
    }

    const imgData = new ImageData(width, height);
    const pixels = imgData.data;
    const inputBuf = this.inputBuf;
    const windowBuf = this.windowBuffer;

    let dcSum = 0;
    let validCount = 0;
    for (let i = 0; i < windowSize; i++) {
      const idx = startIdx + i;
      if (idx >= 0 && idx < data.length) {
        dcSum += data[idx]!;
        validCount++;
      }
    }

    for (let x = 0; x < width; x++) {
      const signalStart = startIdx + x * hopSize;
      const mean = validCount > 0 ? dcSum / validCount : 0;

      const end = Math.min(windowSize, data.length - signalStart);
      let i = 0;
      for (; i < end; i++) {
        if (
          signalStart + i < data.length &&
          signalStart + i >= 0 &&
          i >= 0 &&
          i < windowSize
        ) {
          inputBuf[i] = (data[signalStart + i]! - mean) * windowBuf[i]!;
        }
      }
      for (; i < this.fftSize; i++) {
        inputBuf[i] = 0;
      }

      const fft = new FFTExecutor(this.fftSize);
      const mags = fft.compute(inputBuf, this.sampleRate, minDb, maxDb);

      for (let y = 0; y < height; y++) {
        if (y < 0 || y >= mags.length) {
          // Index is out of bounds for magnitude array
          break;
        }
        const val = mags[y];
        const rgb = colormapToRgb(val!);
        const row = height - 1 - y;
        const idx = (row * width + x) * 4;
        pixels[idx] = rgb[0];
        pixels[idx + 1] = rgb[1];
        pixels[idx + 2] = rgb[2];
        pixels[idx + 3] = 255;
      }

      if (x + 1 < width) {
        for (let k = 0; k < hopSize; k++) {
          const outIdx = signalStart + k;
          if (outIdx >= 0 && outIdx < data.length) {
            dcSum -= data[outIdx]!;
            validCount--;
          }
        }

        const nextStart = signalStart + windowSize;
        for (let k = 0; k < hopSize; k++) {
          const inIdx = nextStart + k;
          if (inIdx >= 0 && inIdx < data.length) {
            dcSum += data[inIdx]!;
            validCount++;
          }
        }
      }
    }

    return imgData;
  }
}

class FFTExecutor {
  private readonly EPS = 1e-20;
  private readonly INV_LN10 = 1 / Math.LN10;

  private readonly fftSize: number;

  private readonly complexIn: Float32Array;
  private readonly spectrum: Float32Array;

  constructor(fftSize: number) {
    if ((fftSize & (fftSize - 1)) !== 0) {
      throw new Error("FFT size must be power of two");
    }

    this.fftSize = fftSize;

    this.complexIn = new Float32Array(fftSize * 2);
    this.spectrum = new Float32Array(fftSize / 2 + 1);
  }

  size(): number {
    return this.fftSize;
  }

  compute(
    input: Float32Array,
    sampleRate: number,
    minDb: number,
    maxDb: number,
  ): Float32Array {
    const N = this.fftSize;
    const cin = this.complexIn;

    for (let i = 0; i < N; i++) {
      const j = i << 1;
      cin[j] = input[i]!;
      cin[j + 1] = 0;
    }

    // We can use 0 for the startTime because seisplot doesn't use it for fftForward
    const inputDisplayData =
      SeismogramDisplayData.fromContiguousData(
        cin,
        sampleRate,
        DateTime.fromMillis(0),
      );
    const out: Float32Array = fftForward(inputDisplayData).packedFreq;
    const spec = this.spectrum;

    const n = spec.length;
    const invRange = 1 / (maxDb - minDb);
    const eps = this.EPS;
    const invLn10 = this.INV_LN10;

    for (let i = 0; i < n; i++) {
      const realComp = out[i];
      let p = 0;
      // Check if valid FFT output values
      if (realComp !== undefined) {
        p = realComp * realComp + eps;
      }

      const v = (10 * Math.log(p) * invLn10 - minDb) * invRange;
      spec[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }

    return spec;
  }
}

const createWindow = (size: number, type: WindowFunctionType): Float32Array => {
  const window = new Float32Array(size);

  if (type === "rectangular") {
    return window.fill(1);
  }

  const TWO_PI = 2 * Math.PI;
  const denom = size - 1;

  switch (type) {
    case "hann":
      for (let i = 0; i < size; i++) {
        window[i] = 0.5 * (1 - Math.cos((TWO_PI * i) / denom));
      }
      break;
    case "hamming":
      for (let i = 0; i < size; i++) {
        window[i] = 0.54 - 0.46 * Math.cos((TWO_PI * i) / denom);
      }
      break;
    case "blackman":
      for (let i = 0; i < size; i++) {
        const angle = (TWO_PI * i) / denom;
        window[i] = 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle);
      }
      break;
  }

  return window;
};

export type ColorMapName =
  | "viridis"
  | "inferno"
  | "grayscale"
  | "jet"
  | "hot"
  | "cool"
  | "spring"
  | "summer"
  | "autumn"
  | "winter"
  | "bone";

export type RGB = [number, number, number];

function interpolateColorMap(t: number, map: number[][]): RGB {
  if (t <= 0) {
    return map[0] as RGB;
  }
  if (t >= 1) {
    return map[map.length - 1] as RGB;
  }

  const step = 1 / (map.length - 1);
  const idx = (t / step) | 0;
  const localT = (t - idx * step) / step;

  const c1 = map[idx];
  const c2 = map[idx + 1];

  if (!c1 || c1.length < 3 || !c2 || c2.length < 3) {
    return [0, 0, 0];
  }

  return [
    (c1[0]! + (c2[0]! - c1[0]!) * localT) | 0,
    (c1[1]! + (c2[1]! - c1[1]!) * localT) | 0,
    (c1[2]! + (c2[2]! - c1[2]!) * localT) | 0,
  ];
}

const VIRIDIS_MAP = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];
const INFERNO_MAP = [
  [0, 0, 4],
  [87, 16, 110],
  [187, 55, 84],
  [249, 142, 9],
  [252, 255, 164],
];

function viridis(t: number): RGB {
  return interpolateColorMap(t, VIRIDIS_MAP);
}

function inferno(t: number): RGB {
  return interpolateColorMap(t, INFERNO_MAP);
}

function grayscale(t: number): RGB {
  const v = Math.floor(t * 255);
  return [v, v, v];
}

function jet(t: number): RGB {
  // Jet: Blue -> Cyan -> Yellow -> Orange -> Red
  // t: 0..1
  const v = Math.max(0, Math.min(1, t));
  // R: 0 at 0.35, 1 at 0.66
  // G: 0 at 0.12, 1 at 0.37, 1 at 0.64, 0 at 0.89
  // B: 1 at 0.11, 0 at 0.34

  // Simple 4-segment interpolation
  const r = Math.min(4 * v - 1.5, -4 * v + 4.5);
  const g = Math.min(4 * v - 0.5, -4 * v + 3.5);
  const b = Math.min(4 * v + 0.5, -4 * v + 2.5);

  return [
    Math.floor(Math.max(0, Math.min(1, r)) * 255),
    Math.floor(Math.max(0, Math.min(1, g)) * 255),
    Math.floor(Math.max(0, Math.min(1, b)) * 255),
  ];
}

function hot(t: number): RGB {
  // Black -> Red -> Yellow -> White
  // R: 0->1 linear (0-0.33)
  // G: 0 (0-0.33) -> 1 (0.66-1)
  // B: 0 (0-0.66) -> 1 (1)

  // Easier with keypoints:
  // 0.0: 0,0,0
  // 0.33: 255,0,0
  // 0.66: 255,255,0
  // 1.0: 255,255,255

  let r,
    g = 0,
    b = 0;

  if (t < 0.33) {
    r = t / 0.33;
  } else if (t < 0.66) {
    r = 1;
    g = (t - 0.33) / 0.33;
  } else {
    r = 1;
    g = 1;
    b = (t - 0.66) / 0.34;
  }

  return [Math.floor(r * 255), Math.floor(g * 255), Math.floor(b * 255)];
}

function cool(t: number): RGB {
  // Cyan -> Magenta
  // R: 0 -> 1
  // G: 1 -> 0
  // B: 1
  const r = t;
  const g = 1 - t;
  const b = 1;
  return [Math.floor(r * 255), Math.floor(g * 255), Math.floor(b * 255)];
}

function spring(t: number): RGB {
  // Magenta -> Yellow
  // R: 1
  // G: t
  // B: 1 - t
  return [255, Math.floor(t * 255), Math.floor((1 - t) * 255)];
}

function summer(t: number): RGB {
  // Green -> Yellow
  // R: t
  // G: 0.5 + 0.5*t
  // B: 0.4
  // Standard matplotlib 'summer' is simpler
  // 0.0: (0.0, 0.5, 0.4)
  // 1.0: (1.0, 1.0, 0.4)
  return [
    Math.floor(t * 255),
    Math.floor((0.5 + 0.5 * t) * 255),
    Math.floor(0.4 * 255),
  ];
}

function autumn(t: number): RGB {
  // Red -> Orange -> Yellow
  // R: 1
  // G: t
  // B: 0
  return [255, Math.floor(t * 255), 0];
}

function winter(t: number): RGB {
  // Blue -> Green
  // 0.0: (0, 0, 1)
  // 1.0: (0, 1, 0.5)
  // R: 0
  // G: t
  // B: 1.0 - 0.5*t
  return [0, Math.floor(t * 255), Math.floor((1.0 - 0.5 * t) * 255)];
}

function bone(t: number): RGB {
  const r = t;
  const sin = 0.1 * Math.sin(t * Math.PI * 2);
  const g = t < 0.5 ? t + sin : t;
  const b = t < 0.75 ? t + sin : t;

  return [
    Math.floor(Math.min(1, r) * 255),
    Math.floor(Math.min(1, g) * 255),
    Math.floor(Math.min(1, b) * 255),
  ];
}

const COLOR_MAP_FNS: Record<ColorMapName, (t: number) => RGB> = {
  viridis,
  inferno,
  grayscale,
  jet,
  hot,
  cool,
  spring,
  summer,
  autumn,
  winter,
  bone,
};

export class ColorMap {
  private type: ColorMapName;
  private lut: Uint8Array; // [R, G, B, R, G, B...] for 0..255

  constructor(type: ColorMapName = "jet") {
    this.type = type;
    this.lut = new Uint8Array(256 * 3);
    this.generateLut();
  }

  private generateLut() {
    const fn = COLOR_MAP_FNS[this.type];
    for (let i = 0; i < 256; i++) {
      const rgb = fn(i / 255);
      const j = i * 3;
      this.lut[j] = rgb[0];
      this.lut[j + 1] = rgb[1];
      this.lut[j + 2] = rgb[2];
    }
  }

  getRGB(t: number): RGB {
    const idx = (t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0) * 3;
    if (idx < 0 || idx + 2 >= this.lut.length) {
      return [0, 0, 0];
    }
    return [this.lut[idx]!, this.lut[idx + 1]!, this.lut[idx + 2]!];
  }

  setMap(type: ColorMapName) {
    this.type = type;
    this.generateLut();
  }
}
