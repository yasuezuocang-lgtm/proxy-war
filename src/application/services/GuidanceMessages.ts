import type { ParticipantSide } from "../../domain/entities/Participant.js";
import { COURT_LABELS, type CourtLevel } from "../../domain/value-objects/CourtLevel.js";

// SPEC §7.2: 各フェーズ遷移時に 1 回だけ「次に何をすればいいか」を案内する。
// SessionStateMachine は状態遷移時に TransitionEvent を emit し、
// 呼び出し側は guidanceFor() で案内文を取り出して MessageGateway へ流す。
// - DM 向け案内: 該当サイドの依頼人に送る（preparing 系の個別案内など）
// - #talk 向け案内: 両者に見える全体通知（対話開始、判決、上告確定など）
export type TransitionEvent =
  | { type: "moved_to_confirming"; side: ParticipantSide }
  | { type: "moved_to_goal_setting"; side: ParticipantSide }
  | {
      type: "participant_ready";
      side: ParticipantSide;
      sessionReady: boolean;
    }
  | { type: "debate_started"; courtLevel: CourtLevel }
  | { type: "hearing_started"; targetSide: ParticipantSide }
  | { type: "hearing_resolved"; targetSide: ParticipantSide }
  | { type: "round_finished" }
  | {
      type: "judging_completed";
      phase: "appeal_pending" | "finished";
      winner: "A" | "B" | "draw";
      courtLevel: CourtLevel;
      appealableSides: readonly ParticipantSide[];
    }
  | {
      type: "appeal_accepted";
      appellantSide: ParticipantSide;
      nextCourtLevel: CourtLevel;
    }
  | { type: "appeal_expired"; closedAtCourtLevel: CourtLevel }
  | { type: "archived" }
  | { type: "reset" };

export type TransitionListener = (event: TransitionEvent) => void;

export type Guidance =
  | { target: "dm"; side: ParticipantSide; text: string }
  | { target: "talk"; text: string };

// TransitionEvent → 案内文の純関数マップ。
// 返すメッセージは「次の操作」を1つだけ示す（情報過多防止 — SPEC §7.2）。
// target===dm は該当側にのみ、target===talk は #talk に公開投稿する想定。
export function guidanceFor(event: TransitionEvent): Guidance[] {
  switch (event.type) {
    case "moved_to_confirming":
      return [
        {
          target: "dm",
          side: event.side,
          text: "要約はこれで確定でOK？ 合ってれば「はい」、違うとこあれば修正して送って。",
        },
      ];

    case "moved_to_goal_setting":
      return [
        {
          target: "dm",
          side: event.side,
          text: "ゴール設定するなら「ゴール:...」と送って。なしでもOK（「なし」でスキップ）。",
        },
      ];

    case "participant_ready":
      if (event.sessionReady) {
        return [
          {
            target: "talk",
            text: "両者準備完了。#talk で代理対話を始める。",
          },
        ];
      }
      return [
        {
          target: "dm",
          side: event.side,
          text: "準備OK。相手の準備が整ったら #talk で対話が始まる。",
        },
      ];

    case "debate_started":
      return [
        {
          target: "talk",
          text: `⚔️ ${COURT_LABELS[event.courtLevel]}で代理対話を開始する。`,
        },
      ];

    case "hearing_started":
      return [
        {
          target: "dm",
          side: event.targetSide,
          text: "⏸️ 対話中に確認したいことが出た。返信して、終わったら対話再開する。",
        },
      ];

    case "hearing_resolved":
      return [
        {
          target: "dm",
          side: event.targetSide,
          text: "👍 受け取った。対話に反映して再開する。",
        },
      ];

    case "round_finished":
      return [
        {
          target: "talk",
          text: "対話終了。審判AIが判定に入る。",
        },
      ];

    case "judging_completed": {
      if (event.phase === "finished") {
        if (event.courtLevel === "supreme") {
          return [
            {
              target: "talk",
              text: "🔒 最終審で決着。これ以上の上告はできない。",
            },
          ];
        }
        return [
          {
            target: "talk",
            text: "🔒 判定確定。上告枠を使い切った。",
          },
        ];
      }
      // appeal_pending: 敗者（または引き分け時は両者）に上告を案内
      return event.appealableSides.map((side) => ({
        target: "dm" as const,
        side,
        text: "納得いかなければ「上告」とDMで送って。制限時間内に返信がなければ判定確定する。",
      }));
    }

    case "appeal_accepted":
      return [
        {
          target: "talk",
          text: `⚖️ ${event.appellantSide}側の異議申し立てを受理。${COURT_LABELS[event.nextCourtLevel]}で再審する。`,
        },
      ];

    case "appeal_expired":
      return [
        {
          target: "talk",
          text: `⏳ 異議なし。${COURT_LABELS[event.closedAtCourtLevel]}で判定確定。`,
        },
      ];

    case "archived":
      return [
        {
          target: "talk",
          text: "セッションをアーカイブした。もう1回やるなら「リセット」とDMして。",
        },
      ];

    case "reset":
      return [
        {
          target: "talk",
          text: "セッションをリセットした。また本音送ってくれれば新規で始める。",
        },
      ];
  }
}
