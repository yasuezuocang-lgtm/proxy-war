export const SESSION_PHASES = [
  "preparing",
  "ready",
  "debating",
  "hearing",
  "judging",
  "appeal_pending",
  "finished",
  "archived",
] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number];
