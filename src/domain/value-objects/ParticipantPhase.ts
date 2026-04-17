export const PARTICIPANT_PHASES = [
  "waiting",
  "inputting",
  "confirming",
  "goal_setting",
  "ready",
] as const;

export type ParticipantPhase = (typeof PARTICIPANT_PHASES)[number];
