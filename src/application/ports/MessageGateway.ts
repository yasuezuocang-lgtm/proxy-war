export type TalkSpeaker = "A" | "B" | "system";

export interface MessageGateway {
  sendDm(side: "A" | "B", message: string): Promise<void>;
  sendTalkMessage(message: string, speaker?: TalkSpeaker): Promise<void>;
  sendTyping(side: "A" | "B"): Promise<void>;
  // P1-21: #talk チャンネルでも typing アニメーションを表示したいケース
  // （代理対話ターン生成中）で使う。optional にしてあるのは、テスト用の
  // 軽量 Fake（DM しか使わない）を壊さないため。本番実装（DiscordMessageGateway）
  // は必ず提供する。
  sendTalkTyping?(speaker?: TalkSpeaker): Promise<void>;
}
