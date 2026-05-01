import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { resolve, join } from "path";

import type { SessionRepository } from "../../application/ports/SessionRepository.js";
import { asOwnBrief } from "../../application/ports/ParticipantAgent.js";
import { Session } from "../../domain/entities/Session.js";
import { AgentMemory } from "../../domain/entities/AgentMemory.js";
import { DebateRound } from "../../domain/entities/DebateRound.js";
import { Participant, type ParticipantSide } from "../../domain/entities/Participant.js";
import { SessionPolicy } from "../../domain/policies/SessionPolicy.js";
import type { DebateTurn } from "../../domain/entities/DebateTurn.js";
import type { HearingRequest } from "../../domain/entities/HearingRequest.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { Appeal } from "../../domain/entities/Appeal.js";
import type {
  HearingExchange,
  StrategyNote,
} from "../../domain/entities/AgentContext.js";
import type { SessionPhase } from "../../domain/value-objects/SessionPhase.js";
import type { CourtLevel } from "../../domain/value-objects/CourtLevel.js";
import type { ParticipantPhase } from "../../domain/value-objects/ParticipantPhase.js";

// セッションを AES-256-GCM で暗号化してローカル保存する。
// 鍵は hex (64文字 = 32 byte) または 32 byte の生文字列。未起動時は constructor で拒否。
// 保存先は既定 data/sessions/（.gitignore 済み）。1 セッション = 1 ファイル ({sessionId}.enc)。

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM 標準 nonce 長
const FILE_EXTENSION = ".enc";

interface EncryptedPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
  version: 1;
}

// Step 5 / migration-plan §3 Step 5: Participant.brief を廃して AgentMemory に集約。
// privateBrief は OwnBrief<Side> ブランドだが、永続化には plain string で書き出し、
// 復元時に side で型 narrow して asOwnBrief を経由する。
interface SerializedAgentMemory {
  side: ParticipantSide;
  principalId: string;
  privateBrief: string;
  privateGoal: string | null;
  publicGoal: string | null;
  briefSummary: string | null;
  confirmedAt: number | null;
  rawInputs: string[];
  strategyNotes: StrategyNote[];
  hearingHistory: HearingExchange[];
}

interface SerializedParticipant {
  side: ParticipantSide;
  userId: string | null;
  botId: string | null;
  phase: ParticipantPhase;
  followUpCount: number;
}

interface SerializedPolicy {
  maxTurns: number;
  maxHearingsPerSide: number;
  hearingTimeoutMs: number;
  appealTimeoutMs: number;
  maxAppeals: number;
}

interface SerializedRound {
  id: string;
  courtLevel: CourtLevel;
  createdAt: number;
  turns: DebateTurn[];
  hearings: HearingRequest[];
  judgment: Judgment | null;
  appeal: Appeal | null;
}

interface SerializedSession {
  id: string;
  guildId: string;
  createdAt: number;
  phase: SessionPhase;
  topic: string | null;
  appealableSides: ParticipantSide[];
  policy: SerializedPolicy;
  participants: {
    A: SerializedParticipant;
    B: SerializedParticipant;
  };
  agentMemoryA: SerializedAgentMemory;
  agentMemoryB: SerializedAgentMemory;
  rounds: SerializedRound[];
  activeHearing: HearingRequest | null;
}

export interface EncryptedSessionRepositoryOptions {
  // hex 64 文字 または 32 byte 生文字列。
  encryptionKey: string;
  // 既定: {cwd}/data/sessions
  dataDir?: string;
}

export class EncryptedSessionRepository implements SessionRepository {
  private readonly key: Buffer;
  private readonly dir: string;

  constructor(options: EncryptedSessionRepositoryOptions) {
    this.key = parseKey(options.encryptionKey);
    this.dir = options.dataDir ?? resolve(process.cwd(), "data", "sessions");
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  async findActiveByGuildId(guildId: string): Promise<Session | null> {
    const sessions = await this.loadAll();
    const active = sessions
      .filter((s) => s.guildId === guildId && s.phase !== "archived")
      .sort((a, b) => b.createdAt - a.createdAt);
    return active[0] ?? null;
  }

  async findById(sessionId: string): Promise<Session | null> {
    const path = this.pathFor(sessionId);
    if (!existsSync(path)) return null;
    const raw = await readFile(path, "utf-8");
    return this.decryptToSession(raw);
  }

  async save(session: Session): Promise<void> {
    const serialized = serializeSession(session);
    const encrypted = this.encrypt(JSON.stringify(serialized));
    await writeFile(this.pathFor(session.id), JSON.stringify(encrypted), "utf-8");
  }

  async archive(sessionId: string): Promise<void> {
    const session = await this.findById(sessionId);
    if (!session) return;
    session.phase = "archived";
    await this.save(session);
  }

  async delete(sessionId: string): Promise<void> {
    const path = this.pathFor(sessionId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  private pathFor(sessionId: string): string {
    return join(this.dir, `${sessionId}${FILE_EXTENSION}`);
  }

  private async loadAll(): Promise<Session[]> {
    if (!existsSync(this.dir)) return [];
    const entries = readdirSync(this.dir).filter((f) => f.endsWith(FILE_EXTENSION));
    const sessions: Session[] = [];
    for (const entry of entries) {
      const raw = await readFile(join(this.dir, entry), "utf-8");
      try {
        sessions.push(this.decryptToSession(raw));
      } catch {
        // 復号失敗（鍵違い・破損）は無視。運用側で気付けるようスキップのみ。
      }
    }
    return sessions;
  }

  private decryptToSession(raw: string): Session {
    const payload = JSON.parse(raw) as EncryptedPayload;
    const plaintext = this.decrypt(payload);
    const serialized = JSON.parse(plaintext) as SerializedSession;
    return restoreSession(serialized);
  }

  private encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf-8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      version: 1,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: encrypted.toString("base64"),
    };
  }

  private decrypt(payload: EncryptedPayload): string {
    const iv = Buffer.from(payload.iv, "base64");
    const authTag = Buffer.from(payload.authTag, "base64");
    const ciphertext = Buffer.from(payload.ciphertext, "base64");
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf-8");
  }
}

function parseKey(input: string): Buffer {
  if (!input) {
    throw new Error(
      "ENCRYPTION_KEY が空です。npm run setup で自動生成してください。"
    );
  }
  const hex = /^[0-9a-fA-F]+$/;
  if (input.length === 64 && hex.test(input)) {
    return Buffer.from(input, "hex");
  }
  const raw = Buffer.from(input, "utf-8");
  if (raw.length === 32) return raw;
  throw new Error(
    "ENCRYPTION_KEY は 64 文字の hex (= 32 byte) もしくは 32 byte 生文字列を指定してください。"
  );
}

function serializeSession(session: Session): SerializedSession {
  return {
    id: session.id,
    guildId: session.guildId,
    createdAt: session.createdAt,
    phase: session.phase,
    topic: session.topic,
    appealableSides: [...session.appealableSides],
    policy: {
      maxTurns: session.policy.maxTurns,
      maxHearingsPerSide: session.policy.maxHearingsPerSide,
      hearingTimeoutMs: session.policy.hearingTimeoutMs,
      appealTimeoutMs: session.policy.appealTimeoutMs,
      maxAppeals: session.policy.maxAppeals,
    },
    participants: {
      A: serializeParticipant(session.participants.A),
      B: serializeParticipant(session.participants.B),
    },
    agentMemoryA: serializeAgentMemory(session.agentMemoryA),
    agentMemoryB: serializeAgentMemory(session.agentMemoryB),
    rounds: session.rounds.map(serializeRound),
    activeHearing: session.activeHearing,
  };
}

function serializeParticipant(p: Participant): SerializedParticipant {
  return {
    side: p.side,
    userId: p.userId,
    botId: p.botId,
    phase: p.phase,
    followUpCount: p.followUpCount,
  };
}

function serializeAgentMemory<Side extends ParticipantSide>(
  memory: AgentMemory<Side>
): SerializedAgentMemory {
  return {
    side: memory.side,
    principalId: memory.principalId,
    privateBrief: memory.privateBrief,
    privateGoal: memory.privateGoal,
    publicGoal: memory.publicGoal,
    briefSummary: memory.briefSummary,
    confirmedAt: memory.confirmedAt,
    rawInputs: [...memory.rawInputs],
    strategyNotes: memory.strategyNotes.map((note) => ({ ...note })),
    hearingHistory: memory.hearingHistory.map((entry) => ({ ...entry })),
  };
}

function serializeRound(r: DebateRound): SerializedRound {
  return {
    id: r.id,
    courtLevel: r.courtLevel,
    createdAt: r.createdAt,
    turns: r.turns.map((t) => ({ ...t })),
    hearings: r.hearings.map((h) => ({ ...h })),
    judgment: r.judgment ? { ...r.judgment, criteria: r.judgment.criteria.map((c) => ({ ...c })) } : null,
    appeal: r.appeal ? { ...r.appeal } : null,
  };
}

function restoreSession(s: SerializedSession): Session {
  const policy = new SessionPolicy({
    maxTurns: s.policy.maxTurns,
    maxHearingsPerSide: s.policy.maxHearingsPerSide,
    hearingTimeoutMs: s.policy.hearingTimeoutMs,
    appealTimeoutMs: s.policy.appealTimeoutMs,
    maxAppeals: s.policy.maxAppeals,
  });

  const session = new Session({
    id: s.id,
    guildId: s.guildId,
    policy,
    createdAt: s.createdAt,
  });
  session.phase = s.phase;
  session.topic = s.topic;
  session.appealableSides = [...s.appealableSides];
  session.activeHearing = s.activeHearing ? { ...s.activeHearing } : null;

  restoreParticipant(session.participants.A, s.participants.A);
  restoreParticipant(session.participants.B, s.participants.B);
  restoreAgentMemory("A", session.agentMemoryA, s.agentMemoryA);
  restoreAgentMemory("B", session.agentMemoryB, s.agentMemoryB);

  for (const raw of s.rounds) {
    const round = new DebateRound({
      id: raw.id,
      courtLevel: raw.courtLevel,
      createdAt: raw.createdAt,
    });
    round.turns = raw.turns.map((t) => ({ ...t }));
    round.hearings = raw.hearings.map((h) => ({ ...h }));
    round.judgment = raw.judgment
      ? { ...raw.judgment, criteria: raw.judgment.criteria.map((c) => ({ ...c })) }
      : null;
    round.appeal = raw.appeal ? { ...raw.appeal } : null;
    session.rounds.push(round);
  }

  return session;
}

function restoreParticipant(target: Participant, src: SerializedParticipant): void {
  target.phase = src.phase;
  target.followUpCount = src.followUpCount;
  // userId/botId/side は Participant で readonly なので Session 作成時に復元し直す必要があるが、
  // 現 Session 実装では Participant は side のみで空生成されるため userId/botId を同期する。
  (target as unknown as { userId: string | null }).userId = src.userId;
  (target as unknown as { botId: string | null }).botId = src.botId;
}

function restoreAgentMemory<Side extends ParticipantSide>(
  side: Side,
  target: AgentMemory<Side>,
  src: SerializedAgentMemory
): void {
  // principalId は readonly。Session 作成時に "" で初期化されているので、
  // 永続値で上書きするには readonly キャストが必要（既存 userId/botId と同方針）。
  (target as unknown as { principalId: string }).principalId = src.principalId;
  target.privateBrief = asOwnBrief(side, src.privateBrief);
  target.privateGoal = src.privateGoal;
  target.publicGoal = src.publicGoal;
  target.briefSummary = src.briefSummary;
  target.confirmedAt = src.confirmedAt;
  target.rawInputs.length = 0;
  target.rawInputs.push(...src.rawInputs);
  target.strategyNotes.length = 0;
  target.strategyNotes.push(...src.strategyNotes.map((note) => ({ ...note })));
  target.hearingHistory.length = 0;
  target.hearingHistory.push(
    ...src.hearingHistory.map((entry) => ({ ...entry }))
  );
}
