import test from "node:test";
import assert from "node:assert/strict";
import { AppealJudgmentUseCase } from "./AppealJudgmentUseCase.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";
import { Session } from "../../domain/entities/Session.js";
import { SessionPolicy } from "../../domain/policies/SessionPolicy.js";
import { InMemorySessionRepository } from "../../infrastructure/persistence/InMemorySessionRepository.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";

interface SetupOptions {
  judgment?: Judgment;
  appealableSides?: ParticipantSide[];
  phase?: Session["phase"];
  maxAppeals?: number;
  courtLevel?: "district" | "high" | "supreme";
}

const baseJudgment: Judgment = {
  winner: "A",
  criteria: [{ name: "説得力", scoreA: 4, scoreB: 3, reason: "Aの方が一貫" }],
  totalA: 4,
  totalB: 3,
  summary: "A優勢。",
  zopa: "週1で話す。",
  wisdom: "怒りの正体に気づくこと。",
  angerA: null,
  angerB: null,
};

async function setup(opts: SetupOptions = {}) {
  const repo = new InMemorySessionRepository();
  const stateMachine = new SessionStateMachine();
  const session = new Session({
    id: "sess-1",
    guildId: "guild-1",
    policy: new SessionPolicy({
      maxTurns: 4,
      maxAppeals: opts.maxAppeals ?? 2,
    }),
  });

  // 第一審ラウンドを作って判定を入れた状態にする
  session.createRound(opts.courtLevel ?? "district");
  session.setJudgment(opts.judgment ?? baseJudgment);

  // appeal_pending を再現（敗者だけが上告可能）
  const judgment = opts.judgment ?? baseJudgment;
  session.appealableSides =
    opts.appealableSides ??
    (judgment.winner === "draw"
      ? (["A", "B"] as ParticipantSide[])
      : ([judgment.winner === "A" ? "B" : "A"] as ParticipantSide[]));
  session.phase = opts.phase ?? "appeal_pending";

  await repo.save(session);

  const useCase = new AppealJudgmentUseCase(repo, stateMachine);
  return { repo, stateMachine, session, useCase };
}

test("敗者からの上告を受理し、新しい審級ラウンドが作られる", async () => {
  const { useCase, repo } = await setup();

  const result = await useCase.execute({
    sessionId: "sess-1",
    side: "B",
    content: "事実誤認がある",
    now: 1_700_000_000_000,
  });

  assert.equal(result.appeal.appellantSide, "B");
  assert.equal(result.appeal.appealedBy, "B");
  assert.equal(result.appeal.courtLevel, "high");
  assert.equal(result.appeal.content, "事実誤認がある");
  assert.equal(result.nextCourtLevel, "high");
  assert.equal(result.session.rounds.length, 2);
  assert.equal(result.session.rounds[1].courtLevel, "high");
  assert.equal(result.session.rounds[1].appeal?.content, "事実誤認がある");
  assert.deepEqual(result.session.appealableSides, []);
  // 永続化も確認
  const persisted = await repo.findById("sess-1");
  assert.ok(persisted);
  assert.equal(persisted!.rounds.length, 2);
});

test("appeal_pending 以外のフェーズでは DomainError を投げる", async () => {
  const { useCase } = await setup({ phase: "debating" });
  await assert.rejects(
    () =>
      useCase.execute({
        sessionId: "sess-1",
        side: "B",
        content: "異議",
      }),
    (err) => err instanceof DomainError && /appeal_pending/.test(err.message)
  );
});

test("上告権のない側（勝者）からの上告は DomainError", async () => {
  const { useCase } = await setup();
  await assert.rejects(
    () =>
      useCase.execute({
        sessionId: "sess-1",
        side: "A",
        content: "もっと勝ちたい",
      }),
    (err) => err instanceof DomainError && /権限/.test(err.message)
  );
});

test("引き分け判定では上告できない（createAppeal が拒否）", async () => {
  const drawJudgment: Judgment = { ...baseJudgment, winner: "draw" };
  const { useCase } = await setup({ judgment: drawJudgment });

  await assert.rejects(
    () =>
      useCase.execute({
        sessionId: "sess-1",
        side: "A",
        content: "引き分けには納得できない",
      }),
    (err) => err instanceof DomainError && /引き分け/.test(err.message)
  );
});

test("空の異議内容は createAppeal が DomainError を投げる", async () => {
  const { useCase } = await setup();
  await assert.rejects(
    () =>
      useCase.execute({
        sessionId: "sess-1",
        side: "B",
        content: "   \n   ",
      }),
    (err) => err instanceof DomainError && /異議内容/.test(err.message)
  );
});

test("最高裁からの上告は createAppeal が DomainError を投げる", async () => {
  const { useCase, session, repo } = await setup({ courtLevel: "supreme" });
  // setup は第一審を district で作るのでここでは override
  // courtLevel="supreme" の上告 -> 最高裁の判決に対する上告は禁止
  assert.equal(session.rounds[0].courtLevel, "supreme");
  await assert.rejects(
    () =>
      useCase.execute({
        sessionId: "sess-1",
        side: "B",
        content: "最終判断にも納得できない",
      }),
    (err) => err instanceof DomainError && /最高裁/.test(err.message)
  );
  // 状態は appeal_pending のまま（受理されていない）
  const persisted = await repo.findById("sess-1");
  assert.equal(persisted!.phase, "appeal_pending");
});

test("存在しないセッションIDでは DomainError", async () => {
  const { useCase } = await setup();
  await assert.rejects(
    () =>
      useCase.execute({
        sessionId: "missing",
        side: "B",
        content: "異議",
      }),
    (err) => err instanceof DomainError && /見つかりません/.test(err.message)
  );
});

test("受理後、appealableSides は空になり次の判定フェーズへ進む", async () => {
  const { useCase } = await setup();
  const result = await useCase.execute({
    sessionId: "sess-1",
    side: "B",
    content: "異議内容",
  });
  // SessionStateMachine.acceptAppeal の現仕様では、上告審は対話を行わず
  // 直接 judging に遷移する（DebateCoordinator のコメント参照）。
  // 「上告審＝再評価のみ」を採用しているため judging を assert する。
  assert.equal(result.session.phase, "judging");
  assert.deepEqual(result.session.appealableSides, []);
});
