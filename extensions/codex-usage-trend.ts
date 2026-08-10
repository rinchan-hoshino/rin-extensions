import { queryTokenUsageAggregate } from "./codex-usage-store.js";

function safeString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export type UsageTrendPoint = {
  timestamp: string;
  rows: number;
  token_events: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_total: number;
  context_tokens: number;
};

export type UsageTrendSeries = {
  generatedAt: string;
  start: string;
  end: string;
  days: number;
  bucketHours: number;
  points: UsageTrendPoint[];
  total_tokens: number;
  peak_total_tokens: number;
  total_cost: number;
  peak_cost: number;
};

export type UsageTrendOptions = {
  now?: Date | string | number;
  days?: number;
  bucketHours?: number;
};

const DEFAULT_USAGE_TREND_DAYS = 7;
const DEFAULT_USAGE_TREND_BUCKET_HOURS = 3;
const USAGE_TREND_MAX_POINTS = 72;

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function normalizeNowMs(value: UsageTrendOptions["now"]) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const text = safeString(value).trim();
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function toIso(ms: number) {
  return new Date(ms).toISOString();
}

function parseHourBucketMs(value: unknown) {
  const text = safeString(value).trim();
  if (!text) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)
    ? `${text}:00.000Z`
    : text;
  return Date.parse(normalized);
}

function computeTrendRange(nowMs: number, days: number, bucketHours: number) {
  const bucketMs = bucketHours * 3_600_000;
  const windowStartMs = nowMs - days * 24 * 3_600_000;
  const startMs = Math.floor(windowStartMs / bucketMs) * bucketMs;
  const endMs = Math.floor(nowMs / bucketMs) * bucketMs;
  return {
    bucketMs,
    windowStartMs,
    startMs,
    endMs,
    pointCount: Math.max(1, Math.floor((endMs - startMs) / bucketMs) + 1),
  };
}

function emptyTrendPoint(timestamp: string): UsageTrendPoint {
  return {
    timestamp,
    rows: 0,
    token_events: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    cost_total: 0,
    context_tokens: 0,
  };
}

function addTrendMetric(point: UsageTrendPoint, row: Record<string, unknown>) {
  point.rows += Number(row.rows || 0);
  point.token_events += Number(row.token_events || 0);
  point.input_tokens += Number(row.input_tokens || 0);
  point.output_tokens += Number(row.output_tokens || 0);
  point.cache_read_tokens += Number(row.cache_read_tokens || 0);
  point.cache_write_tokens += Number(row.cache_write_tokens || 0);
  point.total_tokens += Number(row.total_tokens || 0);
  point.cost_total += Number(row.cost_total || 0);
  point.context_tokens = Math.max(
    point.context_tokens,
    Number(row.context_tokens || 0),
  );
}

export function buildUsageTrendSeries(
  agentDir: string,
  options: UsageTrendOptions = {},
): UsageTrendSeries {
  const days = clampNumber(options.days, DEFAULT_USAGE_TREND_DAYS, 1, 31);
  let bucketHours = clampNumber(
    options.bucketHours,
    DEFAULT_USAGE_TREND_BUCKET_HOURS,
    1,
    24,
  );
  const nowMs = normalizeNowMs(options.now);
  let range = computeTrendRange(nowMs, days, bucketHours);
  while (range.pointCount > USAGE_TREND_MAX_POINTS && bucketHours < 24) {
    bucketHours += 1;
    range = computeTrendRange(nowMs, days, bucketHours);
  }
  const points = Array.from({ length: range.pointCount }, (_, index) =>
    emptyTrendPoint(toIso(range.startMs + index * range.bucketMs)),
  );

  const rows = queryTokenUsageAggregate({
    agentDir,
    from: toIso(range.windowStartMs),
    to: toIso(nowMs),
    groupBy: ["hour"],
    limit: Math.min(1_000, days * 24 + 24),
    orderBy: "hour",
    direction: "asc",
    includeZero: true,
  });
  for (const row of rows) {
    const hourMs = parseHourBucketMs(row.hour);
    if (!Number.isFinite(hourMs)) continue;
    const index = Math.floor((hourMs - range.startMs) / range.bucketMs);
    if (index < 0 || index >= points.length) continue;
    addTrendMetric(points[index], row);
  }

  const total = points.reduce((sum, point) => sum + point.total_tokens, 0);
  const peak = Math.max(0, ...points.map((point) => point.total_tokens));
  const totalCost = points.reduce((sum, point) => sum + point.cost_total, 0);
  const peakCost = Math.max(0, ...points.map((point) => point.cost_total));
  return {
    generatedAt: toIso(nowMs),
    start: toIso(range.startMs),
    end: toIso(range.endMs),
    days,
    bucketHours,
    points,
    total_tokens: total,
    peak_total_tokens: peak,
    total_cost: totalCost,
    peak_cost: peakCost,
  };
}

export function formatCompactCount(value: unknown) {
  const numeric = Math.max(0, Number(value || 0));
  if (numeric >= 1_000_000_000)
    return `${(numeric / 1_000_000_000).toFixed(1)}B`;
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1)}K`;
  return String(Math.round(numeric));
}

export function formatUsdEquivalent(value: unknown) {
  const numeric = Math.max(0, Number(value || 0));
  if (numeric >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `$${(numeric / 1_000).toFixed(1)}K`;
  return `$${numeric.toFixed(2)}`;
}
