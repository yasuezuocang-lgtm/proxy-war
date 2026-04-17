import type { SessionRepository } from "../ports/SessionRepository.js";
import type { LlmGateway } from "../ports/LlmGateway.js";
import { BriefComposer } from "../services/BriefComposer.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";
import { ConfirmBriefUseCase } from "../usecases/ConfirmBriefUseCase.js";
import { HandleParticipantMessageUseCase } from "../usecases/HandleParticipantMessageUseCase.js";
import { SetGoalUseCase } from "../usecases/SetGoalUseCase.js";
import { StartSessionUseCase } from "../usecases/StartSessionUseCase.js";
import { SubmitInputUseCase } from "../usecases/SubmitInputUseCase.js";

export interface InputWorkflow {
  handleParticipantMessage: HandleParticipantMessageUseCase;
  startSession: StartSessionUseCase;
  submitInput: SubmitInputUseCase;
  confirmBrief: ConfirmBriefUseCase;
  setGoal: SetGoalUseCase;
}

export function createInputWorkflow(
  sessionRepository: SessionRepository,
  llmGateway: LlmGateway
): InputWorkflow {
  const stateMachine = new SessionStateMachine();
  const briefComposer = new BriefComposer(llmGateway);
  const startSession = new StartSessionUseCase(sessionRepository, stateMachine);
  const submitInput = new SubmitInputUseCase(
    sessionRepository,
    startSession,
    stateMachine,
    briefComposer
  );
  const confirmBrief = new ConfirmBriefUseCase(
    sessionRepository,
    stateMachine,
    briefComposer
  );
  const setGoal = new SetGoalUseCase(sessionRepository, stateMachine);
  const handleParticipantMessage = new HandleParticipantMessageUseCase(
    sessionRepository,
    submitInput,
    confirmBrief,
    setGoal
  );

  return {
    handleParticipantMessage,
    startSession,
    submitInput,
    confirmBrief,
    setGoal,
  };
}
