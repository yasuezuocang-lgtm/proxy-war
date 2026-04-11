/** 各側の入力フェーズ（A/B独立で進む） */
export type SidePhase =
  | "waiting"       // セッション開始待ち or まだ何も送っていない
  | "inputting"     // 本音を入力中
  | "confirming"    // AIの要約を確認中
  | "choosing"      // モード選択中（喧嘩 or 話し合い）
  | "confirmed";    // 要約を承認済み

/** セッション全体のフェーズ（両者に影響するグローバル状態） */
export type GlobalPhase =
  | "preparing"     // 入力フェーズ（A/Bそれぞれ独立で進行中）
  | "talking"       // Bot同士が対話中
  | "hearing"       // ヒアリングタイム（対話一時停止中）
  | "judging"       // 審判が判定中
  | "finished";     // 判定完了

export type SessionMode = "normal" | "fight";

export interface SideInput {
  phase: SidePhase;
  rawMessages: string[];          // ユーザーが投入した生テキスト
  structured: string | null;      // AIが構造化した内容
  summary: string | null;         // AIが生成した要約
  confirmed: boolean;             // ユーザーが要約を承認したか
  followUpCount: number;          // 深掘り質問の回数（最大3）
  goal: string | null;            // 喧嘩モード時のゴール
  systemPrompt: string | null;    // 最終的に代理Botに渡すプロンプト
}

export interface DialogueTurn {
  side: "A" | "B";
  content: string;
  timestamp: number;
}

export interface JudgmentResult {
  criteria: { name: string; scoreA: number; scoreB: number; reason: string }[];
  totalA: number;
  totalB: number;
  winner: "A" | "B" | "draw";
  summary: string;
  wisdom: string;
}

/** ヒアリングリクエスト（対話中に依頼人に確認が必要な情報） */
export interface HearingRequest {
  side: "A" | "B";                 // 質問される側
  question: string;                // 依頼人への質問
  context: string;                 // 相手が言ったこと（なぜ聞く必要があるか）
  resolved: boolean;
  answer: string | null;
}

export interface Session {
  id: string;
  guildId: string;
  globalPhase: GlobalPhase;
  mode: SessionMode;
  sideA: SideInput;
  sideB: SideInput;
  dialogue: DialogueTurn[];
  maxTurns: number;
  judgment: JudgmentResult | null;
  topic: string | null;            // テーマ（相手側への通知用）
  notifiedOtherSide: boolean;      // 相手側に通知済みか
  hearing: HearingRequest | null;  // 現在のヒアリングリクエスト
  createdAt: number;
}

function createEmptySideInput(): SideInput {
  return {
    phase: "waiting",
    rawMessages: [],
    structured: null,
    summary: null,
    confirmed: false,
    followUpCount: 0,
    goal: null,
    systemPrompt: null,
  };
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  create(guildId: string, mode: SessionMode = "normal"): Session {
    const id = `${guildId}-${Date.now()}`;
    const session: Session = {
      id,
      guildId,
      globalPhase: "preparing",
      mode,
      sideA: createEmptySideInput(),
      sideB: createEmptySideInput(),
      dialogue: [],
      maxTurns: mode === "fight" ? 10 : 6,
      judgment: null,
      topic: null,
      notifiedOtherSide: false,
      hearing: null,
      createdAt: Date.now(),
    };
    this.sessions.set(guildId, session);
    return session;
  }

  get(guildId: string): Session | undefined {
    return this.sessions.get(guildId);
  }

  getOrCreate(guildId: string): Session {
    return this.sessions.get(guildId) || this.create(guildId);
  }

  getSide(session: Session, side: "A" | "B"): SideInput {
    return side === "A" ? session.sideA : session.sideB;
  }

  delete(guildId: string): void {
    this.sessions.delete(guildId);
  }

  bothConfirmed(session: Session): boolean {
    return session.sideA.confirmed && session.sideB.confirmed;
  }
}
