export type SessionPhase =
  | "idle"
  | "input_a"        // A側が本音を入力中
  | "input_b"        // B側が本音を入力中
  | "confirm_a"      // A側の要約確認中
  | "confirm_b"      // B側の要約確認中
  | "ready"          // 両者の入力完了、対話準備OK
  | "talking"        // Bot同士が対話中
  | "judging"        // 審判が判定中
  | "finished";      // 判定完了

export type SessionMode = "normal" | "fight";

export interface SideInput {
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

export interface Session {
  id: string;
  guildId: string;
  phase: SessionPhase;
  mode: SessionMode;
  sideA: SideInput;
  sideB: SideInput;
  dialogue: DialogueTurn[];
  maxTurns: number;
  judgment: JudgmentResult | null;
  createdAt: number;
}

function createEmptySideInput(): SideInput {
  return {
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
      phase: "idle",
      mode,
      sideA: createEmptySideInput(),
      sideB: createEmptySideInput(),
      dialogue: [],
      maxTurns: mode === "fight" ? 10 : 6,
      judgment: null,
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

  isInputPhase(session: Session): boolean {
    return ["input_a", "input_b", "confirm_a", "confirm_b"].includes(session.phase);
  }

  bothConfirmed(session: Session): boolean {
    return session.sideA.confirmed && session.sideB.confirmed;
  }
}
