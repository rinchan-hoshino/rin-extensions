import type { CodexUsageStatus } from "./codex-usage-client.js";
import { openTokenUsageDb } from "./codex-usage-store.js";

export type QuotaConsumptionPoint = {
  observedAt: string;
  consumedPercent: number;
  percentLeft: number;
};

export type QuotaConsumptionSeries = {
  windowName: string;
  from: string;
  until: string;
  points: QuotaConsumptionPoint[];
  consumedPercent: number;
  peakConsumedPercent: number;
};

function ensureQuotaSchema(agentDir: string) {
  const db = openTokenUsageDb(agentDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_snapshots (
      observed_at TEXT NOT NULL,
      account_id TEXT NOT NULL,
      window_name TEXT NOT NULL,
      percent_left REAL NOT NULL,
      reset_at TEXT NOT NULL DEFAULT '',
      window_seconds INTEGER,
      PRIMARY KEY (account_id, window_name, observed_at)
    );
    CREATE INDEX IF NOT EXISTS idx_quota_snapshots_window_time
      ON quota_snapshots(window_name, observed_at);
  `);
  return db;
}

export function recordCodexQuotaSnapshot(
  status: CodexUsageStatus,
  agentDir: string,
  observedAt = new Date().toISOString(),
): number {
  const rows = status.windows.filter((window) =>
    Number.isFinite(Number(window.percentLeft)),
  );
  if (!rows.length) return 0;
  const db = ensureQuotaSchema(agentDir);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO quota_snapshots
      (observed_at, account_id, window_name, percent_left, reset_at, window_seconds)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const write = db.transaction(() => {
    for (const window of rows) {
      insert.run(
        observedAt,
        status.accountId,
        window.name,
        Number(window.percentLeft),
        window.resetAt || "",
        window.windowSeconds || null,
      );
    }
  });
  write();
  return rows.length;
}

export function queryQuotaConsumptionSeries(
  agentDir: string,
  options: {
    windowName: string;
    from: string;
    until: string;
  },
): QuotaConsumptionSeries {
  const rows = ensureQuotaSchema(agentDir)
    .prepare(
      `SELECT observed_at, percent_left, reset_at
       FROM quota_snapshots
       WHERE window_name = ? AND observed_at >= ? AND observed_at <= ?
       ORDER BY observed_at ASC`,
    )
    .all(options.windowName, options.from, options.until) as Array<{
    observed_at: string;
    percent_left: number;
    reset_at: string;
  }>;
  const points: QuotaConsumptionPoint[] = [];
  let previous: (typeof rows)[number] | undefined;
  for (const row of rows) {
    let consumedPercent = 0;
    if (previous) {
      const sameReset =
        !previous.reset_at ||
        !row.reset_at ||
        previous.reset_at === row.reset_at;
      if (sameReset && row.percent_left < previous.percent_left) {
        consumedPercent = previous.percent_left - row.percent_left;
      }
    }
    points.push({
      observedAt: row.observed_at,
      consumedPercent,
      percentLeft: row.percent_left,
    });
    previous = row;
  }
  return {
    windowName: options.windowName,
    from: options.from,
    until: options.until,
    points,
    consumedPercent: points.reduce(
      (sum, point) => sum + point.consumedPercent,
      0,
    ),
    peakConsumedPercent: Math.max(
      0,
      ...points.map((point) => point.consumedPercent),
    ),
  };
}
