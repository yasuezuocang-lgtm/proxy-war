import type { LLMClient } from "../../llm/provider.js";
import type { ParticipantLlmGateway } from "../../application/ports/LlmGateway.js";
import { BaseDedicatedParticipantAgent } from "./BaseDedicatedParticipantAgent.js";

export class AAgent extends BaseDedicatedParticipantAgent<"A"> {
  constructor(llmClient: LLMClient, llmGateway: ParticipantLlmGateway) {
    super("A", llmClient, llmGateway);
  }

  protected stanceInstruction(): string {
    return (
      "お前はA側専属代理人だ。Aの利益だけを追え。" +
      "Bに歩み寄る提案をする時も、Aにとって得になる形でしか動くな。" +
      "Bの事情を理解しても、Bの味方になるな。"
    );
  }
}
