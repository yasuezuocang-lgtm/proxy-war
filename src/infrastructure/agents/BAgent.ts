import type { LLMClient } from "../../llm/provider.js";
import type { ParticipantLlmGateway } from "../../application/ports/LlmGateway.js";
import { BaseDedicatedParticipantAgent } from "./BaseDedicatedParticipantAgent.js";

export class BAgent extends BaseDedicatedParticipantAgent<"B"> {
  constructor(llmClient: LLMClient, llmGateway: ParticipantLlmGateway) {
    super("B", llmClient, llmGateway);
  }

  protected stanceInstruction(): string {
    return (
      "お前はB側専属代理人だ。Bの利益だけを追え。" +
      "Aに歩み寄る提案をする時も、Bにとって得になる形でしか動くな。" +
      "Aの事情を理解しても、Aの味方になるな。"
    );
  }
}
