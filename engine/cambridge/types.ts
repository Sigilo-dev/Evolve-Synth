export type InteractionType = "SINGLE_CHOICE" | "MULTIPLE_CHOICE" | "DROPDOWN" | "GAP_MATCH" | "TEXT_INPUT" | "UNSUPPORTED";

export type ScreenAnalysis = {
  screenNumber: number | null;
  interactionType: InteractionType;
  questionText: string;
  options: string[];
  externalModelIds: string[];
  selectedAnswers: string[];
};

export type ScreenResult = ScreenAnalysis & {
  outcome: "ANALYZED" | "ANSWERED" | "UNSUPPORTED_INTERACTION" | "FAILED";
  message: string;
  selectionVerified: boolean;
};
