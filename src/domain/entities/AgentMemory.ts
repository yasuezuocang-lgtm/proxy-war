import { asOwnBrief, type OwnBrief } from "../../application/ports/ParticipantAgent.js";
import type { ParticipantSide } from "./Participant.js";
import type {
  HearingExchange,
  StrategyNote,
} from "./AgentContext.js";

// architecture.md §4.2 / migration-plan §3 Step 5:
// A/B 代理人の記憶を Side ジェネリックの集約として独立させる。
// AAgent<"A"> は AgentMemory<"A"> のみ、BAgent<"B"> は AgentMemory<"B"> のみを参照する。
//
// spec フィールド (architecture.md §4.2 / SPEC F-30〜F-33):
//   side / principalId / privateBrief / privateGoal / publicGoal /
//   strategyNotes / hearingHistory
//
// 運用フィールド (Brief 移譲先 / migration-plan §3 Step 5):
//   rawInputs / briefSummary / confirmedAt
//
// privateBrief は OwnBrief<Side> ブランドで型隔離する（DoD 完了条件 #2 / #3）。
// 空状態は null ではなく空文字 "" を使い、既存の `|| ""` フォールバックと整合させる。

export interface AgentMemoryParams<Side extends ParticipantSide> {
  side: Side;
  principalId: string;
  privateBrief?: OwnBrief<Side>;
  privateGoal?: string | null;
  publicGoal?: string | null;
}

export class AgentMemory<Side extends ParticipantSide> {
  readonly side: Side;
  readonly principalId: string;
  privateBrief: OwnBrief<Side>;
  privateGoal: string | null;
  publicGoal: string | null;
  briefSummary: string | null;
  confirmedAt: number | null;
  readonly rawInputs: string[];
  readonly strategyNotes: StrategyNote[];
  readonly hearingHistory: HearingExchange[];

  constructor(params: AgentMemoryParams<Side>) {
    this.side = params.side;
    this.principalId = params.principalId;
    this.privateBrief = params.privateBrief ?? asOwnBrief(params.side, "");
    this.privateGoal = params.privateGoal ?? null;
    this.publicGoal = params.publicGoal ?? null;
    this.briefSummary = null;
    this.confirmedAt = null;
    this.rawInputs = [];
    this.strategyNotes = [];
    this.hearingHistory = [];
  }
}
