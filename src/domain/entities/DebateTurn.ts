import type { ParticipantSide } from "./Participant.js";

export interface DebateTurn {
  speakerSide: ParticipantSide;
  message: string;
  createdAt: number;
}
