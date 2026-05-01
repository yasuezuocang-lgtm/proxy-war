import type { Config, LLMProvider } from "../config.js";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMClient {
  chat(messages: LLMMessage[]): Promise<LLMResponse>;
}

export async function createLLMClient(config: Config): Promise<LLMClient> {
  const { provider, apiKey, model } = config.llm;

  switch (provider) {
    case "anthropic":
      return createAnthropicClient(apiKey, model);
    case "openai":
    case "openrouter":
    case "groq":
      return createOpenAICompatibleClient(provider, apiKey, model);
    case "gemini":
      return createGeminiClient(apiKey, model);
    default:
      throw new Error(`未対応のプロバイダー: ${provider}`);
  }
}

async function createAnthropicClient(
  apiKey: string,
  model: string
): Promise<LLMClient> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  return {
    async chat(messages) {
      const system =
        messages.find((m) => m.role === "system")?.content || "";
      const filtered = messages.filter((m) => m.role !== "system");

      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        system: system || undefined,
        messages: filtered.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";

      return {
        content: text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}

function getBaseURL(provider: LLMProvider): string | undefined {
  switch (provider) {
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "groq":
      return "https://api.groq.com/openai/v1";
    default:
      return undefined;
  }
}

async function createOpenAICompatibleClient(
  provider: LLMProvider,
  apiKey: string,
  model: string
): Promise<LLMClient> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey,
    baseURL: getBaseURL(provider),
  });

  return {
    async chat(messages) {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 2048,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      return {
        content: response.choices[0]?.message?.content || "",
        usage: response.usage
          ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens || 0,
            }
          : undefined,
      };
    },
  };
}

async function createGeminiClient(
  apiKey: string,
  model: string
): Promise<LLMClient> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model });

  return {
    async chat(messages) {
      const system =
        messages.find((m) => m.role === "system")?.content || "";
      const history = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

      const lastMessage = history.pop();
      if (!lastMessage) throw new Error("メッセージが空です");

      const chat = genModel.startChat({
        history,
        systemInstruction: system || undefined,
      });

      const result = await chat.sendMessage(lastMessage.parts[0].text);
      const text = result.response.text();

      return { content: text };
    },
  };
}
