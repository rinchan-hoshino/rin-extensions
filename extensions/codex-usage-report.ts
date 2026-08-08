import {
  listTokenUsageDimensions,
  queryTokenUsageAggregate,
  queryTokenUsageEvents,
} from "./codex-usage-store.js";

export type CodexUsageReportOptions = {
  days: number;
  allTime: boolean;
  groupBy: string[];
  filters: Array<{ key: string; value: string }>;
  events: boolean;
  json: boolean;
  limit: number;
  orderBy: string;
  direction: "asc" | "desc";
  listDimensions: boolean;
};

export function parseCodexUsageReportArgs(
  args: string,
): CodexUsageReportOptions {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const options: CodexUsageReportOptions = {
    days: 7,
    allTime: false,
    groupBy: [],
    filters: [],
    events: false,
    json: false,
    limit: 50,
    orderBy: "total_tokens",
    direction: "desc",
    listDimensions: false,
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = () => {
      const next = tokens[++index];
      if (!next) throw new Error(`Missing value for ${token}`);
      return next;
    };
    if (token === "--days") options.days = Math.max(1, Number(value()) || 7);
    else if (token === "--all-time") options.allTime = true;
    else if (token === "--group-by")
      options.groupBy.push(...value().split(","));
    else if (token === "--filter") {
      const pair = value();
      const split = pair.indexOf("=");
      if (split <= 0) throw new Error(`Invalid filter: ${pair}`);
      options.filters.push({
        key: pair.slice(0, split),
        value: pair.slice(split + 1),
      });
    } else if (token === "--events") options.events = true;
    else if (token === "--json") options.json = true;
    else if (token === "--limit")
      options.limit = Math.max(1, Number(value()) || 50);
    else if (token === "--order-by") options.orderBy = value();
    else if (token === "--asc") options.direction = "asc";
    else if (token === "--desc") options.direction = "desc";
    else if (token === "--list-dimensions") options.listDimensions = true;
    else throw new Error(`Unknown usage option: ${token}`);
  }
  options.groupBy = Array.from(new Set(options.groupBy.filter(Boolean)));
  return options;
}

function value(row: Record<string, unknown>, key: string): string {
  const raw = row[key];
  if (typeof raw === "number")
    return Number.isInteger(raw) ? String(raw) : raw.toFixed(4);
  return String(raw ?? "");
}

function table(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "No Codex usage events matched.";
  const keys = Object.keys(rows[0]);
  const widths = keys.map((key) =>
    Math.min(
      36,
      Math.max(key.length, ...rows.map((row) => value(row, key).length)),
    ),
  );
  const line = (row: Record<string, unknown>) =>
    keys
      .map((key, index) =>
        value(row, key).slice(0, widths[index]).padEnd(widths[index]),
      )
      .join("  ")
      .trimEnd();
  return [
    line(Object.fromEntries(keys.map((key) => [key, key]))),
    ...rows.map(line),
  ].join("\n");
}

export function renderCodexUsageReport(
  agentDir: string,
  options: CodexUsageReportOptions,
  now = new Date(),
): string {
  if (options.listDimensions) {
    return `Usage dimensions: ${listTokenUsageDimensions().join(", ")}`;
  }
  const from = options.allTime
    ? undefined
    : new Date(now.getTime() - options.days * 86_400_000).toISOString();
  const query = {
    agentDir,
    from,
    filters: options.filters,
    limit: options.limit,
    orderBy: options.orderBy,
    direction: options.direction,
  } as const;
  const rows = options.events
    ? queryTokenUsageEvents(query)
    : queryTokenUsageAggregate({ ...query, groupBy: options.groupBy });
  if (options.json) return JSON.stringify(rows, null, 2);
  return table(rows as Array<Record<string, unknown>>);
}
