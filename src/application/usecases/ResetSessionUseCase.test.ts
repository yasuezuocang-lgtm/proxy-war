import test from "node:test";
import assert from "node:assert/strict";

import { ResetSessionUseCase } from "./ResetSessionUseCase.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";
import { InMemorySessionRepository } from "../../infrastructure/persistence/InMemorySessionRepository.js";
import { Session } from "../../domain/entities/Session.js";
import { SessionPolicy } from "../../domain/policies/SessionPolicy.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { SessionPhase } from "../../domain/value-objects/SessionPhase.js";

class RecordingMessageGateway implements MessageGateway {
  readonly dms: { side: "A" | "B"; message: string }[] = [];
  constructor(private readonly unregisteredSides: ("A" | "B")[] = []) {}

  async sendDm(side: "A" | "B", message: string): Promise<void> {
    if (this.unregisteredSides.includes(side)) {
      throw new Error(`${side}側のDMチャンネルが未登録です。`);
    }
    this.dms.push({ side, message });
  }

  async sendTalkMessage(): Promise<void> {}
  async sendTyping(): Promise<void> {}
}

function makeSession(params: {
  id?: string;
  guildId?: string;
  phase?: SessionPhase;
} = {}): Session {
  const session = new Session({
    id: params.id ?? "session-1",
    guildId: params.guildId ?? "guild-1",
    policy: new SessionPolicy({
      maxTurns: 2,
      maxHearingsPerSide: 1,
      hearingTimeoutMs: 1000,
      appealTimeoutMs: 1000,
      maxAppeals: 1,
    }),
  });
  if (params.phase) {
    session.phase = params.phase;
  }
  return session;
}

test("アクティブなセッションが無ければ hadActiveSession=false を返す", async () => {
  const repo = new InMemorySessionRepository();
  const gateway = new RecordingMessageGateway();
  const useCase = new ResetSessionUseCase(
    repo,
    new SessionStateMachine(),
    gateway
  );

  const result = await useCase.execute({ guildId: "guild-1" });

  assert.equal(result.hadActiveSession, false);
  assert.equal(result.archivedSessionId, null);
  assert.deepEqual(result.notifiedSides, []);
  assert.deepEqual(gateway.dms, []);
});

test("preparing フェーズでリセットできる（アーカイブ + 両者通知）", async () => {
  const repo = new InMemorySessionRepository();
  const session = makeSession({ phase: "preparing" });
  await repo.save(session);
  const gateway = new RecordingMessageGateway();
  const useCase = new ResetSessionUseCase(
    repo,
    new SessionStateMachine(),
    gateway
  );

  const result = await useCase.execute({ guildId: "guild-1" });

  assert.equal(result.hadActiveSession, true);
  assert.equal(result.archivedSessionId, "session-1");
  assert.deepEqual(result.notifiedSides, ["A", "B"]);
  assert.equal(session.phase, "archived");
  assert.equal(await repo.findActiveByGuildId("guild-1"), null);
  assert.equal(gateway.dms.length, 2);
  assert.ok(gateway.dms[0].message.includes("リセット"));
});

test("debating フェーズでもリセットできる", async () => {
  const repo = new InMemorySessionRepository();
  const session = makeSession({ phase: "debating" });
  await repo.save(session);
  const useCase = new ResetSessionUseCase(
    repo,
    new SessionStateMachine(),
    new RecordingMessageGateway()
  );

  const result = await useCase.execute({ guildId: "guild-1" });

  assert.equal(result.hadActiveSession, true);
  assert.equal(session.phase, "archived");
  assert.equal(await repo.findActiveByGuildId("guild-1"), null);
});

test("judging フェーズでもリセットできる", async () => {
  const repo = new InMemorySessionRepository();
  const session = makeSession({ phase: "judging" });
  await repo.save(session);
  const useCase = new ResetSessionUseCase(
    repo,
    new SessionStateMachine(),
    new RecordingMessageGateway()
  );

  await useCase.execute({ guildId: "guild-1" });

  assert.equal(session.phase, "archived");
});

test("appeal_pending フェーズでもリセットできる（appealableSides もクリア）", async () => {
  const repo = new InMemorySessionRepository();
  const session = makeSession({ phase: "appeal_pending" });
  session.appealableSides = ["B"];
  await repo.save(session);
  const useCase = new ResetSessionUseCase(
    repo,
    new SessionStateMachine(),
    new RecordingMessageGateway()
  );

  await useCase.execute({ guildId: "guild-1" });

  assert.equal(session.phase, "archived");
  assert.deepEqual(session.appealableSides, []);
});

test("hearing フェーズでもリセットできる（activeHearing もクリア）", async () => {
  const repo = new InMemorySessionRepository();
  const session = makeSession({ phase: "hearing" });
  session.activeHearing = {
    requestedBy: "A",
    targetSide: "A",
    question: "？",
    context: "",
    createdAt: Date.now(),
    answer: null,
    answeredAt: null,
  };
  await repo.save(session);
  const useCase = new ResetSessionUseCase(
    repo,
    new SessionStateMachine(),
    new RecordingMessageGateway()
  );

  await useCase.execute({ guildId: "guild-1" });

  assert.equal(session.phase, "archived");
  assert.equal(session.activeHearing, null);
});

test("finished フェーズでもリセットできる", async () => {
  const repo = new InMemorySessionRepository();
  const session = makeSession({ phase: "finished" });
  await repo.save(session);
  const useCase = new ResetSessionUseCase(
    repo,
    new SessionStateMachine(),
    new RecordingMessageGateway()
  );

  await useCase.execute({ guildId: "guild-1" });

  assert.equal(session.phase, "archived");
  assert.equal(await repo.findActiveByGuildId("guild-1"), null);
});

test("片側のDMチャンネルしか無ければ登録済み側だけ通知される", async () => {
  const repo = new InMemorySessionRepository();
  const session = makeSession({ phase: "preparing" });
  await repo.save(session);
  const gateway = new RecordingMessageGateway(["B"]);
  const useCase = new ResetSessionUseCase(
    repo,
    new SessionStateMachine(),
    gateway
  );

  const result = await useCase.execute({ guildId: "guild-1" });

  assert.equal(result.hadActiveSession, true);
  assert.deepEqual(result.notifiedSides, ["A"]);
  assert.equal(gateway.dms.length, 1);
  assert.equal(gateway.dms[0].side, "A");
});

test("リセット後は新規セッションを開始できる状態になる", async () => {
  const repo = new InMemorySessionRepository();
  const session = makeSession({ phase: "debating" });
  await repo.save(session);
  const useCase = new ResetSessionUseCase(
    repo,
    new SessionStateMachine(),
    new RecordingMessageGateway()
  );

  await useCase.execute({ guildId: "guild-1" });

  assert.equal(await repo.findActiveByGuildId("guild-1"), null);

  const fresh = makeSession({ id: "session-2", phase: "preparing" });
  await repo.save(fresh);
  const active = await repo.findActiveByGuildId("guild-1");
  assert.equal(active?.id, "session-2");
});

test("参加者 phase も waiting にリセットされる", async () => {
  const repo = new InMemorySessionRepository();
  const session = makeSession({ phase: "debating" });
  session.participants.A.phase = "ready";
  session.participants.B.phase = "ready";
  await repo.save(session);
  const useCase = new ResetSessionUseCase(
    repo,
    new SessionStateMachine(),
    new RecordingMessageGateway()
  );

  await useCase.execute({ guildId: "guild-1" });

  assert.equal(session.participants.A.phase, "waiting");
  assert.equal(session.participants.B.phase, "waiting");
});
