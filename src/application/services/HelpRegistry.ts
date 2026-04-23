import type { SessionPhase } from "../../domain/value-objects/SessionPhase.js";
import type { ParticipantPhase } from "../../domain/value-objects/ParticipantPhase.js";

// SPEC §7.3 / §7.4: `help` / `ヘルプ` は全フェーズで動き、
// 現フェーズで使えるコマンドのみを文脈依存で返す。
// ここは純関数のみ。ユースケース側が session を見て HelpContext を組み立てる。

export interface HelpContext {
  readonly sessionPhase: SessionPhase | null;
  readonly participantPhase: ParticipantPhase | null;
  readonly canAppeal: boolean;
}

const HELP_PREFIX = "今できる操作:";
const RESET_LINE = "「リセット」でセッション破棄";

export function isHelpCommand(message: string): boolean {
  const t = message.trim().toLowerCase();
  return t === "help" || t === "ヘルプ";
}

export function buildHelpMessage(ctx: HelpContext): string {
  const lines = availableCommands(ctx);
  return [HELP_PREFIX, ...lines.map((l) => `・${l}`)].join("\n");
}

function availableCommands(ctx: HelpContext): string[] {
  if (ctx.sessionPhase === null) {
    return ["本音をそのまま送る（複数回OK）", RESET_LINE];
  }

  if (ctx.sessionPhase === "preparing") {
    switch (ctx.participantPhase) {
      case "waiting":
      case "inputting":
        return ["本音をそのまま送る（複数回OK）", RESET_LINE];
      case "confirming":
        return [
          "「はい」で要約を確定",
          "修正したい点を送る",
          RESET_LINE,
        ];
      case "goal_setting":
        return [
          "「ゴール:◯◯」でゴール設定",
          "「なし」でゴールをスキップ",
          RESET_LINE,
        ];
      case "ready":
        return ["相手の準備待ち", RESET_LINE];
      default:
        return [RESET_LINE];
    }
  }

  if (ctx.sessionPhase === "ready") {
    return ["#talk で代理対話がまもなく始まる", RESET_LINE];
  }

  if (ctx.sessionPhase === "debating") {
    return [
      "#talk で代理人同士が喧嘩中。見守る",
      RESET_LINE,
    ];
  }

  if (ctx.sessionPhase === "hearing") {
    return [
      "代理人からのヒアリング質問にDMで答える",
      RESET_LINE,
    ];
  }

  if (ctx.sessionPhase === "judging") {
    return ["審判の判決待ち", RESET_LINE];
  }

  if (ctx.sessionPhase === "appeal_pending") {
    const cmds: string[] = [];
    if (ctx.canAppeal) {
      cmds.push("「上告」でもう一度戦う（期限あり）");
    } else {
      cmds.push("相手の上告判断待ち");
    }
    cmds.push(RESET_LINE);
    return cmds;
  }

  if (ctx.sessionPhase === "finished" || ctx.sessionPhase === "archived") {
    return [
      "新しい本音を送って次のセッションを始める",
      RESET_LINE,
    ];
  }

  return [RESET_LINE];
}
