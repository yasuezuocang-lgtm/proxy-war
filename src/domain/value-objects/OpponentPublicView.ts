import type { ParticipantSide } from "../entities/Participant.js";

// SPEC F-30 / F-31: 相手側エージェントから見える「公開ゴール」のみを露出する型。
// SPEC F-32: 私的ゴール（privateGoal）は絶対にここに含めない。
// SPEC F-33: 公開ゴール未設定でも対話開始可（=> publicGoal は null 許容）。
//
// architecture.md §4.2 / migration-plan §3 Step 5:
// agentMemoryA<"A"> から見た B 側の最小情報、または agentMemoryB<"B"> から見た A 側の最小情報を、
// 型レベルで「これだけ」に縛るためのドメイン値型。
export interface OpponentPublicView {
  readonly side: ParticipantSide;
  readonly publicGoal: string | null;
}
