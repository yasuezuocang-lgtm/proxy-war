import type { ParticipantSide } from "./Participant.js";

// 異議申し立て: 前審の判定に納得しない側が、次審の審判に渡す材料。
// 再審AI・最終審AIはこの内容と過去判定を踏まえて再評価する。
export interface Appeal {
  appellantSide: ParticipantSide;
  content: string;
  createdAt: number;
}
