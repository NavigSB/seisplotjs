import { DateTime } from "luxon";
import { SeismogramDisplayData } from "./seismogram.mjs";
import { Seismograph } from "./seismograph.mjs";
import { fftForward } from "./fft.mjs";
import { SeismographConfig, numberFormatWrapper } from "./seismographconfig.mjs";
import { clearCanvas } from "./seismographutil.mjs";
import { util } from "./index_node.mjs";
import type { Axis } from "d3-axis";
import type { NumberValue as d3NumberValue } from "d3-scale";
import {
  axisLeft as d3axisLeft,
  axisRight as d3axisRight,
} from "d3-axis";

export type WindowFunctionType =
  | "hann"
  | "hamming"
  | "blackman"
  | "rectangular";
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

const SPECTROGRAM_ELEMENT = "sp-spectrogram";

export class SpectrogramConfig extends SeismographConfig {
  // The number of points used to compute the FFT, determining the number of frequency bins in the spectrogram
  fftSize: number = 256;
  // The number of samples extracted for each distinct time frame. Must be <= fftSize
  windowSize: number = 256;
  // How much to overlap each FFT frame (as a fraction of the windowSize). A higher overlap results in smoother spectrograms, but
  // increases computation time
  overlapPerc: number = 0.86;
  // Minimum time window for each spectrogram slice in seconds - ideally, resulting chunk times will be near this value. A higher
  // value results in bigger chunks and better performance, but may result in a less smooth spectrogram
  minChunkTime: number = 10;
  // Type of window function to apply
  windowType: WindowFunctionType = "hann";
  // Frequency range for the spectrogram display in Hz - always constrained to not exceed the Nyquist frequency (sampleRate / 2)
  freqMin: number = 0;
  freqMax: number = 15;
  // Function to format frequency values for display on the y-axis. Default is to format with 1 decimal place
  frequencyFormat: (val: number) => string = (val) => val.toFixed(1);
  // Lower and upper bounds for spectrogram color scaling in decibels. FFT power values below minDb are shown as the darkest
  // color, and values above maxDb are shown as the brightest color.
  minDb: number = 30;
  maxDb: number = 150;
  // Color map for spectrogram display
  spectrogramColorMap: ColorMapName = "jet";

  constructor() {
    super();
    // Set new defaults for SeismographConfig fields
    this.yLabel = "Frequency";
  }
}

export class Spectrogram extends Seismograph {
  spectrogramConfig: SpectrogramConfig;
  canvasRenderer: CanvasRenderer;

  constructor(seisData?: SeismogramDisplayData | SeismogramDisplayData[], seisConfig?: SpectrogramConfig) {
    super(seisData, seisConfig);
    this.spectrogramConfig = seisConfig || new SpectrogramConfig();
    this.canvasRenderer = new CanvasRenderer(
      this.canvas?.node() as HTMLCanvasElement,
      this.spectrogramConfig.windowSize,
    );
  }

  override drawSeismograms() {
    if (!this.isVisible()) {
      // no need to draw if we are not visible
      return;
    }
    // Clear the canvas before drawing, making sure the canvasRenderer is set to the current canvas
    const canvas = this.canvas?.node();
    if (!canvas)
      return;
    clearCanvas(canvas);
    this.canvasRenderer.setCanvas(canvas);

    // Draw a separate SpectrogramModel for each SeismogramDisplayData in the list to adjust for different sample rates and start times
    this._seisDataList.forEach((sdd) => {
      // Get the time range for the view of the spectrogram and validate
      const xScale = this.timeScaleForSeisDisplayData(sdd, true);
      const domainStart = xScale.domain().start?.valueOf();
      const domainEnd = xScale.domain().end?.valueOf();
      if (domainStart == null || domainEnd == null || domainStart === domainEnd) {
        return;
      }

      // Get seismogram and sampleRate, and validate
      const seismogram = sdd.seismogram;
      if (!seismogram)
        return;
      const dataSampleRate = seismogram.sampleRate;
      if (dataSampleRate == null)
        return;

      // Convert the domain start and end times to seconds from epoch, and get the full seismogram data and start time in seconds
      const viewStartTime = domainStart / 1000;
      const viewEndTime = domainEnd / 1000;
      const fullSeisData = new Float32Array(seismogram.y);
      const seismogramStartSec = seismogram.startTime.valueOf() / 1000;

      // Initialize the spectrogram model for this particular seismogram and set the data
      const spectrogram = new SpectrogramModel(
        this.spectrogramConfig,
        dataSampleRate,
        seismogramStartSec,
      );
      spectrogram.setData(fullSeisData);

      // Render the spectrogram to the canvas, using our calculated view start and end times to calculate where each chunk should be
      // drawn. We use catch because the rendering is async and we don't want to block the main thread if an error occurs
      this.canvasRenderer.render(spectrogram, viewStartTime, viewEndTime).catch((err) => {
        util.warn(`Error rendering spectrogram: ${err.message}`);
        return;
      });
    });
  }

  // We need to override the normal axis creation to be frequencies instead of amplitudes, and to constrain the frequency
  // range to the Nyquist frequency
  override createLeftRightAxis(): Array<Axis<d3NumberValue> | null> {
    let yAxis = null;
    let yAxisRight = null;

    // Constrain the y-coordinates to be within the safe frequency range
    const sampleRate = this.seisData.reduce(
      (acc, curr) => Math.min(curr.seismogram?.sampleRate || Infinity, acc),
      Infinity
    );
    const nyquist = sampleRate !== Infinity ? sampleRate / 2 : 0;
    const safeFMax = Math.min(this.spectrogramConfig.freqMax, nyquist);
    const safeFMin = Math.max(this.spectrogramConfig.freqMin, 0);
    // We can use __initAmpScale because it initializes the scale range to the height of the plot - then we just need to set
    // the domain to the safe frequency range
    const axisScale = this.__initAmpScale().domain([safeFMin, safeFMax]);

    // Create the left and right axes just like the normal Seismograph, but with frequency formatting instead of amplitude formatting
    if (this.spectrogramConfig.isYAxis) {
      yAxis = d3axisLeft(axisScale).tickFormat(
        numberFormatWrapper(this.spectrogramConfig.frequencyFormat),
      );
      yAxis.scale(axisScale);
      yAxis.ticks(this.spectrogramConfig.yAxisNumTickHint, this.spectrogramConfig.frequencyFormat);
    }
    if (this.spectrogramConfig.isYAxisRight) {
      yAxisRight = d3axisRight(axisScale).tickFormat(
        numberFormatWrapper(this.spectrogramConfig.frequencyFormat),
      );
      yAxisRight.scale(axisScale);
      yAxisRight.ticks(this.spectrogramConfig.yAxisNumTickHint, this.spectrogramConfig.frequencyFormat);
    }
    return [yAxis, yAxisRight];
  }

  override createUnitsLabel() {
    if (this.spectrogramConfig && this.spectrogramConfig.ySublabelIsUnits) {
      return "Hz";
    }
    return "";
  }

  override seisDataUpdated() {
    // Invalidate the cache when the data is updated, so that new chunks will be generated for the new data
    this.canvasRenderer.clearCache();
    super.seisDataUpdated();
  }
}
customElements.define(SPECTROGRAM_ELEMENT, Spectrogram);

class SpectrogramModel {
  config: SpectrogramConfig;
  sampleRate: number;
  data: Float32Array | null = null;

  showRealTimeScale: boolean = false;
  // Start time of the spectrogram in seconds from epoch
  startTime: number = 0;

  constructor(config: SpectrogramConfig, sampleRate: number, startTime: number) {
    this.config = config;
    this.sampleRate = sampleRate;
    this.startTime = startTime;
  }

  setData(data: Float32Array) {
    this.data = data;
  }
}

class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private windowSize: number;

  private chunksCache: Map<string, DataChunk> = new Map();

  constructor(canvas: HTMLCanvasElement, canvasSize: number) {
    this.canvas = canvas;
    this.windowSize = canvasSize;
  }

  clearCache() {
    this.chunksCache.clear();
  }

  setCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  /**
   * Renders the SpectrogramModel on the given canvas at the specified time and frequency ranges
   * @param canvas The canvas element on which to render the spectrogram
   * @param viewStartTime The start time of the view range in seconds from epoch
   * @param viewEndTime The end time of the view range in seconds from epoch
   * @returns A promise resolving when rendering is complete
   */
  async render(spectrogram: SpectrogramModel, viewStartTime: number, viewEndTime: number) {
    this.ctx = this.canvas.getContext("2d", { alpha: true })!;
    const processor = new ChunkProcessor(
      spectrogram.config,
      spectrogram.sampleRate,
      this.windowSize,
    );
    if (!this.ctx || !spectrogram.data || !spectrogram.data.length || viewStartTime >= viewEndTime) {
      return;
    }

    // Get time and frequency range from model
    const dataStartTime = spectrogram.startTime;
    const dataEndTime = dataStartTime + spectrogram.data?.length / spectrogram.sampleRate;
    const fMin = spectrogram.config.freqMin;
    const fMax = spectrogram.config.freqMax;

    const colorMap = new ColorMap(spectrogram.config.spectrogramColorMap);

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Calculates how big each chunk should be according to the desired time range and overlap
    const sampleRate = spectrogram.sampleRate;
    const overlap = Math.floor(spectrogram.config.overlapPerc * this.windowSize);
    const hopSize = Math.max(1, this.windowSize - overlap);

    // Calculates the number of samples to include in each chunk based on the desired minimum chunk
    // time. A minimum chunk time is often used for performance reasons
    const targetSamples = spectrogram.config.minChunkTime * sampleRate;
    const hopsPerChunk = Math.ceil(targetSamples / hopSize);
    const chunkSamples = hopsPerChunk * hopSize;

    // Calculates where the data starts and ends relative to the start of the view range while
    // respecting the view boundaries
    const overlapStartAbs = Math.max(viewStartTime, dataStartTime);
    const overlapEndAbs = Math.min(viewEndTime, dataEndTime);
    if (overlapEndAbs <= overlapStartAbs)
      return;
    const dataRelStartIdx = Math.floor((overlapStartAbs - dataStartTime) * sampleRate);
    const dataRelEndIdx = Math.ceil((overlapEndAbs - dataStartTime) * sampleRate);

    // Only render the chunks that have data
    const startChunkId = Math.floor(dataRelStartIdx / chunkSamples);
    const endChunkId = Math.floor((dataRelEndIdx - 1) / chunkSamples);

    for (let i = startChunkId; i <= endChunkId; i++) {
      let chunkStart = i * chunkSamples;
      let chunkEnd = (i + 1) * chunkSamples;
      let chunkId = `chunk_${i}`;

      // If the chunk is only partially filled with data, it is a special chunk and should not be stored in
      // the cache in the same way as a regular chunk
      if (chunkStart < dataRelStartIdx || chunkEnd > dataRelEndIdx) {
        chunkStart = Math.max(chunkStart, dataRelStartIdx);
        chunkEnd = Math.min(chunkEnd, dataRelEndIdx);
        chunkId = `chunk_${chunkStart}_${chunkEnd}`;
      }

      let chunk = this.chunksCache.get(chunkId);
      if (!chunk) {
        const newChunk = new DataChunk(
          chunkId,
          chunkStart,
          chunkEnd,
          sampleRate,
        );
        this.chunksCache.set(chunkId, newChunk);

        // Convert the processed data to an image
        const imgData = processor.process(
          spectrogram.data,
          chunkStart,
          chunkEnd,
          spectrogram.config,
          (val: number) => colorMap.getRGB(val),
        );

        // Store the created image into the chunk so it can be reused
        const bmp = await createImageBitmap(imgData);
        newChunk.image = bmp;

        chunk = newChunk;
      }

      if (chunk.image && this.ctx) {
        // Fills any unused part of the canvas with background
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.clip();

        this.drawChunk(
          spectrogram,
          chunk,
          viewStartTime,
          viewEndTime,
          fMin,
          fMax
        );

        this.ctx.restore();
      }
    }
  }

  /**
   * Draws a chunk of spectrogram within the view range
   * @param ctx 2D rendering context to draw on
   * @param chunk DataChunk instance to draw
   * @param viewStartTime Start time of the view range in seconds
   * @param viewEndTime End time of the view range in seconds
   * @param fMin Minimum frequency to display
   * @param fMax Maximum frequency to display
   * @param plotW Width of the plot area
   * @param plotH Height of the plot area
   */
  private drawChunk(
    spectrogram: SpectrogramModel,
    chunk: DataChunk,
    viewStartTime: number,
    viewEndTime: number,
    fMin: number, // Hz
    fMax: number, // Hz
  ) {
    if (!chunk.image) {
      return;
    }

    const viewDuration = viewEndTime - viewStartTime;
    const sampleRate = spectrogram.sampleRate;
    const nyquist = sampleRate / 2;

    const chunkStartTime = spectrogram.startTime + chunk.startIndex / sampleRate;
    const chunkEndTime = spectrogram.startTime + chunk.endIndex / sampleRate;

    // Calculate the x-coordinates for the chunk within the plot area
    const plotW = this.canvas.width;
    const x1 = ((chunkStartTime - viewStartTime) / viewDuration) * plotW;
    const x2 = ((chunkEndTime - viewStartTime) / viewDuration) * plotW;

    if (x2 <= 0 || x1 >= plotW)
      return;

    // Constrain the x-coordinates to the plot area
    const chunkX = Math.max(0, x1);
    const chunkW = Math.min(plotW, x2) - chunkX;

    // If the x-coordinates don't fill the entire chunk area, draw only the portion that does
    const texW = chunk.image.width;
    const drawStartX = ((chunkX - x1) / (x2 - x1)) * texW;
    const drawWidth = (chunkW / (x2 - x1)) * texW;

    // Constrain the y-coordinates to be within the safe frequency range
    const safeFMax = Math.min(fMax, nyquist);
    const safeFMin = Math.max(fMin, 0);

    // If the y-coordinates don't fill the entire frequency range, draw only the portion that does
    const texH = chunk.image.height;
    const drawStartY = (1 - safeFMax / nyquist) * texH;
    const drawEndY = (1 - safeFMin / nyquist) * texH;
    const drawHeight = drawEndY - drawStartY;

    if (this.ctx && drawHeight > 0) {
      this.ctx.drawImage(
        chunk.image,
        drawStartX,
        drawStartY,
        drawWidth,
        drawHeight,
        chunkX,
        0,
        chunkW,
        this.canvas.height
      );
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

  /**
   * Processes the seismic data to create a spectrogram using fftForward, the given colormap, and
   * index offsets for the input data.
   * @param data The seismic data to process
   * @param startIdx The starting index of the data to start the chunk at
   * @param endIdx The ending index of the data to end the chunk at
   * @param config The spectrogram configuration
   * @param colormapToRgb The function to convert normalized values to RGB colors
   * @returns The processed spectrogram image data
   */
  process(
    data: Float32Array,
    startIdx: number,
    endIdx: number,
    config: SpectrogramConfig,
    colormapToRgb: (normalizedVal: number) => [number, number, number],
  ): ImageData {
    const { minDb, maxDb, overlapPerc } = config;
    const windowSize = this.windowBuffer.length;
    const overlap = Math.floor(overlapPerc * windowSize);
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
