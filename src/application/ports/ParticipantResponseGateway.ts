import type { ParticipantSide } from "../../domain/entities/Participant.js";

export interface AnyResponse {
  side: ParticipantSide;
  response: string;
}

export interface ParticipantResponseGateway {
  waitForResponse(
    side: ParticipantSide,
    timeoutMs: number
  ): Promise<string | null>;

  // 複数側のどれかが先に返答した時点でその応答を返す。
  // タイムアウトで null。引き分け時の「どちらからでも上告OK」で使う。
  waitForAnyResponse(
    sides: ParticipantSide[],
    timeoutMs: number
  ): Promise<AnyResponse | null>;
}
