import type { ParticipantSide } from "./Participant.js";

export interface HearingRequest {
  requestedBy: ParticipantSide;
  targetSide: ParticipantSide;
  question: string;
  context: string;
  createdAt: number;
  answeredAt: number | null;
  answer: string | null;
}
