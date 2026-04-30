import type { ParticipantSide } from "../entities/Participant.js";
import type { OwnBrief } from "../../application/ports/ParticipantAgent.js";

// migration-plan §3 Step 7 / agents.md §6 / requirements.md N-01〜N-05:
// 型レベル（OwnBrief<Side> brand / ParticipantAgent<Side> phantom typing）で
// A/B 情報リークが既に弾かれているが、ランタイムでも二重チェックを行う。
//
// 設計方針:
//   - IsolationPolicy 自体は副作用を持たない静的メソッド集（純粋ガード）
//   - 違反検知時は DomainError 相当の Error を throw（呼び出し側が握りつぶさない）
//   - 本番環境（NODE_ENV !== "production" 以外）では assert を no-op 化し、
//     ログだけ残す運用を許容（リスク表 §5 のオーバーヘッド対策）
//
// 環境変数:
//   ISOLATION_POLICY=strict  → 常に throw（dev/test 既定）
//   ISOLATION_POLICY=lenient → ログのみ（本番想定。デフォルト）
//
// テスト:
//   src/domain/policies/IsolationPolicy.test.ts に違反シナリオを書く。
import { DomainError } from "../errors/DomainError.js";

export type IsolationPolicyMode = "strict" | "lenient";

interface SideOperationLog {
  operation: string;
  side: ParticipantSide;
  at: number;
}

const operationLog: SideOperationLog[] = [];

function resolveMode(): IsolationPolicyMode {
  const raw = process.env.ISOLATION_POLICY;
  if (raw === "strict" || raw === "lenient") {
    return raw;
  }
  // 既定は test/dev で strict、本番で lenient（NODE_ENV=production の時のみ lenient）。
  return process.env.NODE_ENV === "production" ? "lenient" : "strict";
}

export class IsolationPolicy {
  // OwnBrief<Side> ブランドは型レベルで保証されるが、
  // 「実装ミスで any 経由に渡された側違いの brief」を一段防ぐ。
  // brief 文字列の中に `[OPP_BRIEF:` のような他側マーカーが混じっていないか
  // を最低限確認する（agent 内部でのコンテンツ生成時点での誤注入チェック）。
  static assertOwnBriefAccess<Side extends ParticipantSide>(
    side: Side,
    brief: OwnBrief<Side>
  ): void {
    this.recordOperation(`assertOwnBrief(${side})`, side);
    if (typeof brief !== "string") {
      this.violate(
        `brief は string でなければならない（side=${side}, actual=${typeof brief}）`
      );
      return;
    }
    const opponent: ParticipantSide = side === "A" ? "B" : "A";
    if (brief.includes(`[OWN_BRIEF:${opponent}]`)) {
      this.violate(
        `${side} 代理人が ${opponent} 側の brief マーカーを保持している`
      );
    }
  }

  // 司会（DebateCoordinator）が AgentMemory<A|B> 本体への参照を保持していないこと。
  // 「司会は誰の本音も持たない」要件をランタイムでも担保する。
  // フィールドの存在チェックで済ませる（Reflect.ownKeys 走査）。
  static assertNoOpponentMemoryRef(coordinator: object): void {
    this.recordOperation("assertNoOpponentMemoryRef", "A");
    const fieldNames = Object.keys(coordinator);
    const leakingFields = fieldNames.filter((name) =>
      /agentMemoryA|agentMemoryB|privateBrief|privateGoal/i.test(name)
    );
    if (leakingFields.length > 0) {
      this.violate(
        `司会クラスに代理人記憶フィールドが直接保持されている: ${leakingFields.join(", ")}`
      );
    }
  }

  // 運用要件 N-42: 全 LLM 呼び出しと DM 送信ログに side を含める。
  // 呼び出し側で `IsolationPolicy.logSideOperation("llm.appendBrief", "A")` のように
  // 呼んでもらい、テストやメトリクスから後で集計できるようにする。
  static logSideOperation(operation: string, side: ParticipantSide): void {
    this.recordOperation(operation, side);
  }

  // テスト用。直近の操作ログを取り出す。
  static recentOperations(limit = 50): readonly SideOperationLog[] {
    return operationLog.slice(-limit);
  }

  // テスト用。ログをクリアする（テストごとに副作用が漏れないように）。
  static clearOperationLog(): void {
    operationLog.length = 0;
  }

  private static recordOperation(
    operation: string,
    side: ParticipantSide
  ): void {
    operationLog.push({ operation, side, at: Date.now() });
    // 過去 1000 件を超えたら古い分を捨てる（OOM 防止）。
    if (operationLog.length > 1000) {
      operationLog.splice(0, operationLog.length - 1000);
    }
  }

  private static violate(message: string): void {
    const mode = resolveMode();
    if (mode === "strict") {
      throw new DomainError(`IsolationPolicy 違反: ${message}`);
    }
    console.warn(`[IsolationPolicy] ${message}`);
  }
}
