export interface Brief {
  rawInputs: string[];
  structuredContext: string | null;
  summary: string | null;
  confirmedAt: number | null;
  goal: string | null;
}

export function createEmptyBrief(): Brief {
  return {
    rawInputs: [],
    structuredContext: null,
    summary: null,
    confirmedAt: null,
    goal: null,
  };
}
