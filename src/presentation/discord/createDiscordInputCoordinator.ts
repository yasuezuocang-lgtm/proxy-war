import type { DMChannel } from "discord.js";
import type { LLMClient } from "../../llm/provider.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { SessionRepository } from "../../application/ports/SessionRepository.js";
import { createInputWorkflow } from "../../application/factories/createInputWorkflow.js";
import { PromptDrivenLlmGateway } from "../../infrastructure/llm/PromptDrivenLlmGateway.js";
import { TOPIC_EXTRACT_PROMPT } from "../../llm/prompts.js";
import { DiscordInputCoordinator } from "./DiscordInputCoordinator.js";
import {
  DiscordMessageGateway,
  type TalkChannelProvider,
} from "./DiscordMessageGateway.js";
import { PendingParticipantResponseRegistry } from "./PendingParticipantResponseRegistry.js";

export interface CreateDiscordInputCoordinatorParams {
  guildId: string;
  llmClient: LLMClient;
  sessionRepository: SessionRepository;
  botNames: Record<ParticipantSide, string>;
  getTalkChannelBySide: Record<ParticipantSide, TalkChannelProvider>;
  getSystemTalkChannel: TalkChannelProvider;
}

export function createDiscordInputCoordinator(
  params: CreateDiscordInputCoordinatorParams
) {
  const dmChannels = new Map<ParticipantSide, DMChannel>();
  const llmGateway = new PromptDrivenLlmGateway(params.llmClient);
  const workflow = createInputWorkflow(params.sessionRepository, llmGateway);
  const messageGateway = new DiscordMessageGateway(dmChannels, {
    A: params.getTalkChannelBySide.A,
    B: params.getTalkChannelBySide.B,
    system: params.getSystemTalkChannel,
  });
  const pendingResponseRegistry = new PendingParticipantResponseRegistry();

  const coordinator = new DiscordInputCoordinator({
    sessionRepository: params.sessionRepository,
    handleParticipantMessageUseCase: workflow.handleParticipantMessage,
    pendingResponseRegistry,
    extractTopic: async (rawText: string) => {
      const response = await params.llmClient.chat([
        { role: "system", content: TOPIC_EXTRACT_PROMPT },
        { role: "user", content: rawText },
      ]);
      return response.content.trim() || "（テーマ取得中）";
    },
    announceTopic: async ({ side, topic }) => {
      const otherSide = side === "A" ? "B" : "A";
      await messageGateway.sendTalkMessage(
        `📢「${topic}」で対話準備中。\n` +
          `もう一方の人は **${params.botNames[otherSide]}** にDMで本音送って。`
      );
    },
  });

  return {
    llmGateway,
    workflow,
    coordinator,
    pendingResponseRegistry,
    registerDmChannel(side: ParticipantSide, channel: DMChannel): void {
      dmChannels.set(side, channel);
    },
    messageGateway,
  };
}
