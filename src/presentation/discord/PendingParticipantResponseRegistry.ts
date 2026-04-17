import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type {
  AnyResponse,
  ParticipantResponseGateway,
} from "../../application/ports/ParticipantResponseGateway.js";

type ResponseResolver = (answer: string | null) => void;

export class PendingParticipantResponseRegistry
  implements ParticipantResponseGateway
{
  private readonly resolvers = new Map<ParticipantSide, ResponseResolver>();

  async waitForResponse(
    side: ParticipantSide,
    timeoutMs: number
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolvers.delete(side);
        resolve(null);
      }, timeoutMs);

      this.resolvers.set(side, (answer: string | null) => {
        clearTimeout(timer);
        this.resolvers.delete(side);
        resolve(answer);
      });
    });
  }

  async waitForAnyResponse(
    sides: ParticipantSide[],
    timeoutMs: number
  ): Promise<AnyResponse | null> {
    if (sides.length === 0) {
      return null;
    }

    return new Promise((resolve) => {
      let settled = false;

      const cleanup = (): void => {
        for (const s of sides) {
          this.resolvers.delete(s);
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
      }, timeoutMs);

      for (const side of sides) {
        this.resolvers.set(side, (answer: string | null) => {
          if (settled) return;
          if (answer === null) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          resolve({ side, response: answer });
        });
      }
    });
  }

  resolve(side: ParticipantSide, message: string): boolean {
    const resolver = this.resolvers.get(side);
    if (!resolver) {
      return false;
    }

    resolver(message);
    return true;
  }
}
