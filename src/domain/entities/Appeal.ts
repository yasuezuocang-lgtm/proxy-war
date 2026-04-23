import { DomainError } from "../errors/DomainError.js";
import type { CourtLevel } from "../value-objects/CourtLevel.js";
import type { ParticipantSide } from "./Participant.js";

// 異議申し立て: 前審の判定に納得しない側が、次審の審判に渡す材料。
// 再審AI・最終審AIはこの内容と過去判定を踏まえて再評価する。
//
// SPEC §6.8 準拠。createAppeal() ファクトリ経由で生成すると SPEC のバリデーション
// （引き分け禁止 / 最高裁からの上告禁止 / 勝者の上告禁止）が全て走る。
// 既存の直接構築（{ appellantSide, content, createdAt } のみの plain-object）
// との後方互換のため、新フィールドは optional にしてある。将来 createAppeal に
// 統一された段階で required に昇格させる。
export interface Appeal {
  appellantSide: ParticipantSide;
  content: string;
  createdAt: number;
  // SPEC §6.8 に従って createAppeal() が常に設定するフィールド群。
  appealedBy?: ParticipantSide;
  appealedAt?: number;
  courtLevel?: CourtLevel; // この上告が進む先の審級（district→high, high→supreme）
}

export interface CreateAppealInput {
  side: ParticipantSide;
  content: string;
  currentCourtLevel: CourtLevel; // 判定が出たばかりの審級
  winner: ParticipantSide | "draw"; // 前審の判定結果
  now?: number;
}

// 上告先の審級を返す。district → high, high → supreme。最高裁から先は無い。
export function nextCourtLevel(current: CourtLevel): CourtLevel | null {
  if (current === "district") return "high";
  if (current === "high") return "supreme";
  return null;
}

// SPEC §6.8 に従って Appeal を生成する。呼び出し元はこの関数を経由することで
// バリデーションを通過済みの Appeal を得る。
export function createAppeal(input: CreateAppealInput): Appeal {
  if (input.winner === "draw") {
    throw new DomainError("引き分けの判定には上告できません。");
  }
  if (input.side === input.winner) {
    throw new DomainError("勝者側は上告できません。");
  }
  const nextLevel = nextCourtLevel(input.currentCourtLevel);
  if (nextLevel === null) {
    throw new DomainError("最高裁の判決に対しては上告できません。");
  }
  const trimmed = input.content.trim();
  if (!trimmed) {
    throw new DomainError("異議内容を空にはできません。");
  }

  const at = input.now ?? Date.now();
  return {
    appellantSide: input.side,
    appealedBy: input.side,
    courtLevel: nextLevel,
    content: trimmed,
    createdAt: at,
    appealedAt: at,
  };
}
