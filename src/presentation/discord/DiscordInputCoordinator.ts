import type { DMChannel } from "discord.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { HandleParticipantMessageUseCase } from "../../application/usecases/HandleParticipantMessageUseCase.js";
import type { SessionRepository } from "../../application/ports/SessionRepository.js";
import { PendingParticipantResponseRegistry } from "./PendingParticipantResponseRegistry.js";

export interface DiscordInputCoordinatorDeps {
  sessionRepository: SessionRepository;
  handleParticipantMessageUseCase: HandleParticipantMessageUseCase;
  pendingResponseRegistry?: PendingParticipantResponseRegistry;
  announceTopic?: (params: {
    guildId: string;
    side: ParticipantSide;
    topic: string;
  }) => Promise<void>;
  extractTopic?: (rawText: string) => Promise<string>;
}

export class DiscordInputCoordinator {
  private readonly dmChannels = new Map<ParticipantSide, DMChannel>();

  constructor(private readonly deps: DiscordInputCoordinatorDeps) {}

  async handleDirectMessage(params: {
    guildId: string;
    side: ParticipantSide;
    text: string;
    channel: DMChannel;
  }): Promise<void> {
    const text = params.text.trim();
    if (!text) {
      return;
    }

    this.dmChannels.set(params.side, params.channel);

    const activeSession = await this.deps.sessionRepository.findActiveByGuildId(
      params.guildId
    );
    if (
      activeSession?.phase === "hearing" &&
      activeSession.activeHearing?.targetSide === params.side &&
      this.deps.pendingResponseRegistry?.resolve(params.side, text)
    ) {
      await params.channel.send("👍 受け取った。対話に反映して再開する。");
      return;
    }

    // 上告フェーズ: 上告権のある側のDMは異議内容として受け取り、レジストリへ通知する。
    // 引き分け時は両側から受け付ける。リセット操作は通らせたいので除外する。
    if (
      activeSession?.phase === "appeal_pending" &&
      activeSession.appealableSides.includes(params.side) &&
      !this.isResetCommand(text) &&
      this.deps.pendingResponseRegistry?.resolve(params.side, text)
    ) {
      return;
    }

    if (activeSession?.phase === "finished") {
      await params.channel.send(
        "終了済み。もう1回やるなら「リセット」って送って。"
      );
      return;
    }

    if (this.isResetCommand(text)) {
      await this.resetSession(params.guildId, params.channel);
      return;
    }

    const result = await this.deps.handleParticipantMessageUseCase.execute({
      guildId: params.guildId,
      side: params.side,
      message: text,
    });

    await params.channel.send(result.reply);

    if (result.handledBy === "submit_input" && result.movedToConfirming) {
      await this.maybeAnnounceTopic(params.guildId, params.side);
    }
  }

  getDmChannel(side: ParticipantSide): DMChannel | null {
    return this.dmChannels.get(side) ?? null;
  }

  private isResetCommand(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes("リセット") ||
      lower.includes("新しく始める") ||
      lower === "reset"
    );
  }

  private async resetSession(guildId: string, channel: DMChannel): Promise<void> {
    const session = await this.deps.sessionRepository.findActiveByGuildId(guildId);
    if (session) {
      await this.deps.sessionRepository.delete(session.id);
    }

    await channel.send("リセットした。また本音送って。");
  }

  private async maybeAnnounceTopic(
    guildId: string,
    side: ParticipantSide
  ): Promise<void> {
    const session = await this.deps.sessionRepository.findActiveByGuildId(guildId);
    if (!session || session.topic || !this.deps.announceTopic || !this.deps.extractTopic) {
      return;
    }

    const participant = session.getParticipant(side);
    const rawText = participant.brief.rawInputs.join("\n");
    const topic = await this.deps.extractTopic(rawText);
    session.topic = topic;
    await this.deps.sessionRepository.save(session);

    await this.deps.announceTopic({
      guildId,
      side,
      topic,
    });
  }
}
