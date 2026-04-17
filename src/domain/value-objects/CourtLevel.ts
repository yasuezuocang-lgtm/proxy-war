export const COURT_LEVELS = [
  "district",
  "high",
  "supreme",
] as const;

export type CourtLevel = (typeof COURT_LEVELS)[number];

export const COURT_LABELS: Record<CourtLevel, string> = {
  district: "地方裁判所",
  high: "高等裁判所",
  supreme: "最高裁判所",
};
