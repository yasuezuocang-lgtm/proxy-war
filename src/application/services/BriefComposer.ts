import type {
  AppendBriefInput,
  ParticipantLlmGateway,
  StructuredBrief,
} from "../ports/LlmGateway.js";

export class BriefComposer {
  constructor(private readonly llmGateway: ParticipantLlmGateway) {}

  async composeFromRawInputs(rawInputs: string[]): Promise<StructuredBrief> {
    return this.llmGateway.extractBrief({ rawInputs });
  }

  async appendToBrief(input: AppendBriefInput): Promise<StructuredBrief> {
    return this.llmGateway.appendBrief(input);
  }

  async generateProbe(structuredContext: string): Promise<string> {
    return this.llmGateway.generateProbe(structuredContext);
  }

  hasSignificantGaps(structuredContext: string): boolean {
    const gapPatterns = [
      /■インタレスト[^■]*不明/s,
      /■武器[^■]*不明/s,
      /■弱点[^■]*不明/s,
      /■NGワード[^■]*未確認/s,
    ];

    let gapCount = 0;
    for (const pattern of gapPatterns) {
      if (pattern.test(structuredContext)) {
        gapCount++;
      }
    }

    return gapCount >= 2;
  }
}
