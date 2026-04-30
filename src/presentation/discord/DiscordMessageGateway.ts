import type { DMChannel, TextChannel } from "discord.js";
import type {
  MessageGateway,
  TalkSpeaker,
} from "../../application/ports/MessageGateway.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";

export type TalkChannelProvider = () => Promise<TextChannel | null>;

export class DiscordMessageGateway implements MessageGateway {
  constructor(
    private readonly dmChannels: Map<ParticipantSide, DMChannel>,
    private readonly talkChannelProviders: Record<TalkSpeaker, TalkChannelProvider>
  ) {}

  async sendDmToA(message: string): Promise<void> {
    await this.sendDmInternal("A", message);
  }

  async sendDmToB(message: string): Promise<void> {
    await this.sendDmInternal("B", message);
  }

  async sendTalkMessage(
    message: string,
    speaker: TalkSpeaker = "system"
  ): Promise<void> {
    const provider = this.talkChannelProviders[speaker];
    const channel = await provider();
    if (!channel) {
      throw new Error("#talk チャンネルが見つかりません。");
    }

    await channel.send(message);
  }

  async sendTypingToA(): Promise<void> {
    await this.sendTypingInternal("A");
  }

  async sendTypingToB(): Promise<void> {
    await this.sendTypingInternal("B");
  }

  private async sendDmInternal(
    side: ParticipantSide,
    message: string
  ): Promise<void> {
    const channel = this.dmChannels.get(side);
    if (!channel) {
      throw new Error(`${side}側のDMチャンネルが未登録です。`);
    }
    await channel.send(message);
  }

  private async sendTypingInternal(side: ParticipantSide): Promise<void> {
    const channel = this.dmChannels.get(side);
    if (!channel) {
      return;
    }
    await channel.sendTyping();
  }

  async sendTalkTyping(speaker: TalkSpeaker = "system"): Promise<void> {
    const provider = this.talkChannelProviders[speaker];
    const channel = await provider();
    if (!channel) {
      return;
    }

    await channel.sendTyping();
  }
}
