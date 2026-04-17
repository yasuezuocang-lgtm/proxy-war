export type TalkSpeaker = "A" | "B" | "system";

export interface MessageGateway {
  sendDm(side: "A" | "B", message: string): Promise<void>;
  sendTalkMessage(message: string, speaker?: TalkSpeaker): Promise<void>;
  sendTyping(side: "A" | "B"): Promise<void>;
}
