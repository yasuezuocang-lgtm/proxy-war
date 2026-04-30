export type TalkSpeaker = "A" | "B" | "system";

// migration-plan §3 Step 6 / §6 二重実装解消:
// 旧 sendDm(side, message) / sendTyping(side) は side をランタイム値で受け取るため
// 「うっかり A 向けの本音を B チャンネルに流す」を型レベルで弾けない。
// A 側・B 側それぞれの送信口を完全に分けることで、誤配を構造的に不可能にする。
export interface MessageGateway {
  sendDmToA(message: string): Promise<void>;
  sendDmToB(message: string): Promise<void>;
  sendTalkMessage(message: string, speaker?: TalkSpeaker): Promise<void>;
  sendTypingToA(): Promise<void>;
  sendTypingToB(): Promise<void>;
  // #talk チャンネルでも typing アニメーションを表示したいケース
  // （代理対話ターン生成中）で使う。optional にしてあるのは、テスト用の
  // 軽量 Fake（DM しか使わない）を壊さないため。本番実装（DiscordMessageGateway）
  // は必ず提供する。
  sendTalkTyping?(speaker?: TalkSpeaker): Promise<void>;
}
