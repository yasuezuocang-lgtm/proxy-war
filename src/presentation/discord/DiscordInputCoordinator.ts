import type { DMChannel } from "discord.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type {
  HandleParticipantMessageUseCase,
  ParticipantMessageResult,
} from "../../application/usecases/HandleParticipantMessageUseCase.js";
import type { ResetSessionUseCase } from "../../application/usecases/ResetSessionUseCase.js";
import type { SessionRepository } from "../../application/ports/SessionRepository.js";
import { PendingParticipantResponseRegistry } from "./PendingParticipantResponseRegistry.js";

export interface DiscordInputCoordinatorDeps {
  sessionRepository: SessionRepository;
  handleParticipantMessageUseCase: HandleParticipantMessageUseCase;
  resetSessionUseCase: ResetSessionUseCase;
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

    // P1-25 / SPEC §7.4: リセットは全フェーズ最優先で処理する。
    // hearing の未解決回答・appeal_pending の異議受付・debating/judging の
    // 「観戦中」案内より先にここで捕まえないと、リセット文字列が
    // 誤って別用途に消費されてしまう。
    if (this.isResetCommand(text)) {
      await this.deps.resetSessionUseCase.execute({ guildId: params.guildId });
      return;
    }

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
    // 引き分け時は両側から受け付ける。リセット操作は上のガードで既に処理済み。
    if (
      activeSession?.phase === "appeal_pending" &&
      activeSession.appealableSides.includes(params.side) &&
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

    // 代理対話中・判定中に DM が来た場合の案内。
    // リセットは既に上で処理済みなので、ここには到達しない。
    if (activeSession?.phase === "debating") {
      await params.channel.send("今Bot同士が戦ってる。#talk 見てて。");
      return;
    }
    if (activeSession?.phase === "judging") {
      await params.channel.send("判定中。ちょっと待って。");
      return;
    }

    // LLM 処理中は Discord ネイティブの「入力中...」アニメーションを表示する。
    // Discord の typing は ~10 秒で消えるため、処理が終わるまで 8 秒ごとに再送する。
    await params.channel.sendTyping();
    const typingRefresh = setInterval(() => {
      params.channel.sendTyping().catch(() => {});
    }, 8000);

    let result: ParticipantMessageResult;
    try {
      result = await this.deps.handleParticipantMessageUseCase.execute({
        guildId: params.guildId,
        side: params.side,
        message: text,
      });
    } finally {
      clearInterval(typingRefresh);
    }

    await params.channel.send(result.reply);

    if (result.handledBy === "submit_input" && result.movedToConfirming) {
      await this.maybeAnnounceTopic(params.guildId, params.side);
    }
  }

  getDmChannel(side: ParticipantSide): DMChannel | null {
    return this.dmChannels.get(side) ?? null;
  }

  private isResetCommand(text: string): boolean {
    const lower = text.toLowerCase().trim();
    return (
      lower.includes("リセット") ||
      lower.includes("新しく始める") ||
      lower === "reset"
    );
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
