import type { ParticipantSide } from "./Participant.js";

export interface JudgmentCriterion {
  name: string;
  scoreA: number;
  scoreB: number;
  reason: string;
}

export interface Judgment {
  winner: ParticipantSide | "draw";
  criteria: JudgmentCriterion[];
  totalA: number;
  totalB: number;
  summary: string;
  zopa: string | null;
  wisdom: string | null;
  angerA: string | null;
  angerB: string | null;
}
