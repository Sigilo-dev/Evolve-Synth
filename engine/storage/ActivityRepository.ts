import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ScreenAnalysis } from "../cambridge/types.js";
import type { FeedbackResult, SubmittedAnswer } from "../cambridge/FeedbackParser.js";

export type RunSummary = { id: number; activityName: string; activityUrl: string; startedAt: string; finishedAt: string | null; status: string; score: number | null; maximumScore: number | null; endReason: string | null; screensProcessed: number; correctScreens: number; errorScreens: number; unsupportedScreens: number };

export class ActivityRepository {
  private readonly db: Database.Database;
  constructor(dataDirectory: string) {
    const storage = join(dataDirectory, "data");
    mkdirSync(storage, { recursive: true });
    this.db = new Database(join(storage, "evolve-synth.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }
  close(): void { this.db.close(); }
  startRun(activityName: string, activityUrl: string): number {
    return Number(this.db.prepare("INSERT INTO ActivityRuns (ActivityName, ActivityUrl, StartedAt, Status) VALUES (?, ?, ?, 'RUNNING')").run(activityName, activityUrl, now()).lastInsertRowid);
  }
  recordScreen(runId: number, analysis: ScreenAnalysis, answers: SubmittedAnswer[] = []): number {
    if (analysis.screenNumber !== null) {
      const existing = this.db.prepare("SELECT Id FROM ScreenAttempts WHERE ActivityRunId = ? AND ScreenNumber = ? ORDER BY Id DESC LIMIT 1").get(runId, analysis.screenNumber) as { Id: number } | undefined;
      if (existing) {
        this.db.prepare("UPDATE ScreenAttempts SET InteractionType = ?, QuestionText = ?, QuestionExternalId = ?, Result = NULL, Feedback = NULL, CreatedAt = ? WHERE Id = ?")
          .run(analysis.interactionType, analysis.questionText, analysis.externalModelIds[0] ?? null, now(), existing.Id);
        this.db.prepare("DELETE FROM Answers WHERE ScreenAttemptId = ?").run(existing.Id);
        return existing.Id;
      }
    }
    const screenId = Number(this.db.prepare("INSERT INTO ScreenAttempts (ActivityRunId, ScreenNumber, InteractionType, QuestionText, QuestionExternalId, Result, Feedback, CreatedAt) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)").run(runId, analysis.screenNumber, analysis.interactionType, analysis.questionText, analysis.externalModelIds[0] ?? null, now()).lastInsertRowid);
    this.insertAnswers(screenId, answers);
    return screenId;
  }
  completeScreen(screenId: number, feedback: FeedbackResult): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE ScreenAttempts SET Result = ?, Feedback = ? WHERE Id = ?").run(feedback.result, feedback.feedback, screenId);
      // The feedback panel enumerates gap answers as "1 answer", "2 answer".
      // Store the number as SlotNumber rather than making it part of AnswerText.
      const prefixSources = feedback.answers.filter(answer => answer.answerPrefix !== null);
      const listedCorrectAnswers = feedback.correctAnswers.map(parseListedCorrectAnswer).map((answer, index) => {
        const bySlot = answer.slotNumber === null ? undefined : prefixSources.find(source => source.slotNumber === answer.slotNumber);
        const byPosition = prefixSources.length === feedback.correctAnswers.length ? prefixSources[index] : undefined;
        const onlySource = prefixSources.length === 1 ? prefixSources[0] : undefined;
        return { ...answer, answerPrefix: bySlot?.answerPrefix ?? byPosition?.answerPrefix ?? onlySource?.answerPrefix ?? null };
      });
      const listedByText = new Map(
        listedCorrectAnswers.map(answer => [normaliseAnswerText(answer.answerText), answer]),
      );
      const selectedAnswers = feedback.answers.map(answer => {
        const listed = listedByText.get(normaliseAnswerText(answer.answerText));
        return listed && answer.slotNumber === null ? { ...answer, slotNumber: listed.slotNumber } : answer;
      });

      this.insertAnswers(screenId, selectedAnswers, true);
      const selectedTexts = new Set(selectedAnswers.map(answer => normaliseAnswerText(answer.answerText)));
      this.insertAnswers(screenId, listedCorrectAnswers
        .filter(answer => !selectedTexts.has(normaliseAnswerText(answer.answerText)))
        .map(answer => ({
          externalModelId: null,
          slotNumber: answer.slotNumber,
          answerText: answer.answerText,
          answerPrefix: answer.answerPrefix,
          wasSelected: false,
          wasCorrect: true,
        })));
    })();
  }
  updateSubmittedAnswers(screenId: number, answers: SubmittedAnswer[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM Answers WHERE ScreenAttemptId = ?").run(screenId);
      this.insertAnswers(screenId, answers);
    })();
  }
  recordEvent(runId: number, level: string, eventType: string, message: string): void {
    this.db.prepare("INSERT INTO RunEvents (ActivityRunId, Timestamp, Level, EventType, Message) VALUES (?, ?, ?, ?, ?)").run(runId, now(), level, eventType, message);
  }
  finishRun(runId: number, status: string, endReason: string, score: number | null, maximumScore: number | null): RunSummary {
    this.db.prepare("UPDATE ActivityRuns SET FinishedAt = ?, Status = ?, Score = ?, MaximumScore = ?, EndReason = ? WHERE Id = ?").run(now(), status, score, maximumScore, endReason, runId);
    return this.summary(runId);
  }
  summary(runId: number): RunSummary {
    const run = this.db.prepare("SELECT * FROM ActivityRuns WHERE Id = ?").get(runId) as Record<string, unknown>;
    const screens = this.uniqueScreenRows(runId);
    return {
      id: Number(run.Id), activityName: String(run.ActivityName), activityUrl: String(run.ActivityUrl), startedAt: String(run.StartedAt), finishedAt: run.FinishedAt as string | null, status: String(run.Status), score: run.Score as number | null, maximumScore: run.MaximumScore as number | null, endReason: run.EndReason as string | null,
      screensProcessed: screens.length,
      correctScreens: screens.filter(screen => screen.Result === "CORRECT").length,
      errorScreens: screens.filter(screen => screen.Result === "SOME_ERRORS").length,
      unsupportedScreens: screens.filter(screen => screen.Result === "UNSUPPORTED").length,
    };
  }
  exportRun(runId: number): Record<string, unknown> {
    const summary = this.summary(runId);
    const screens = this.uniqueScreenRows(runId).map(screen => ({
      screen_number: screen.ScreenNumber, interaction_type: screen.InteractionType, question: screen.QuestionText, question_external_id: screen.QuestionExternalId, result: screen.Result, feedback: screen.Feedback,
      submitted_answers: this.db.prepare("SELECT ExternalModelId external_model_id, SlotNumber slot_number, AnswerText answer_text, AnswerPrefix answer_prefix, WasSelected was_selected, WasCorrect was_correct FROM Answers WHERE ScreenAttemptId = ? AND WasSelected = 1 ORDER BY Id").all(screen.Id),
      ...(() => {
        const answers = this.db.prepare("SELECT AnswerText, AnswerPrefix FROM Answers WHERE ScreenAttemptId = ? AND WasCorrect = 1 ORDER BY Id").all(screen.Id) as Array<{ AnswerText: string; AnswerPrefix: string | null }>;
        return { correct_answers: answers.map(answer => answer.AnswerText), correct_answer_prefixes: answers.map(answer => answer.AnswerPrefix) };
      })()
    }));
    return { activity_name: summary.activityName, activity_url: summary.activityUrl, started_at: summary.startedAt, finished_at: summary.finishedAt, status: summary.status, score: summary.score, maximum_score: summary.maximumScore, end_reason: summary.endReason, screens };
  }
  recentRuns(limit = 12): RunSummary[] {
    const ids = this.db.prepare("SELECT Id FROM ActivityRuns ORDER BY Id DESC LIMIT ?").all(limit) as { Id: number }[];
    return ids.map(row => this.summary(row.Id));
  }
  clearRuns(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM RunEvents").run();
      this.db.prepare("DELETE FROM Answers").run();
      this.db.prepare("DELETE FROM ScreenAttempts").run();
      this.db.prepare("DELETE FROM ActivityRuns").run();
    })();
  }
  private insertAnswers(screenId: number, answers: SubmittedAnswer[], replace = false): void {
    if (replace) this.db.prepare("DELETE FROM Answers WHERE ScreenAttemptId = ?").run(screenId);
    const insert = this.db.prepare("INSERT INTO Answers (ScreenAttemptId, ExternalModelId, SlotNumber, AnswerText, AnswerPrefix, WasSelected, WasCorrect) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const answer of answers) insert.run(screenId, answer.externalModelId, answer.slotNumber, answer.answerText, answer.answerPrefix, answer.wasSelected ? 1 : 0, answer.wasCorrect === null ? null : answer.wasCorrect ? 1 : 0);
  }
  private uniqueScreenRows(runId: number): Record<string, unknown>[] {
    const rows = this.db.prepare("SELECT * FROM ScreenAttempts WHERE ActivityRunId = ? ORDER BY Id").all(runId) as Record<string, unknown>[];
    const byScreen = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      // Legacy runs may already contain duplicates. Prefer the latest saved
      // row, which has the complete feedback, and show one card per step.
      const key = row.ScreenNumber == null ? `row:${row.Id}` : `screen:${row.ScreenNumber}`;
      byScreen.set(key, row);
    }
    return [...byScreen.values()].sort((left, right) => Number(left.Id) - Number(right.Id));
  }
  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ActivityRuns (Id INTEGER PRIMARY KEY, ActivityName TEXT NOT NULL, ActivityUrl TEXT NOT NULL, StartedAt TEXT NOT NULL, FinishedAt TEXT, Status TEXT NOT NULL, Score INTEGER, MaximumScore INTEGER, EndReason TEXT);
CREATE TABLE IF NOT EXISTS ScreenAttempts (Id INTEGER PRIMARY KEY, ActivityRunId INTEGER NOT NULL REFERENCES ActivityRuns(Id), ScreenNumber INTEGER, InteractionType TEXT NOT NULL, QuestionText TEXT, QuestionExternalId TEXT, Result TEXT, Feedback TEXT, CreatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS Answers (Id INTEGER PRIMARY KEY, ScreenAttemptId INTEGER NOT NULL REFERENCES ScreenAttempts(Id), ExternalModelId TEXT, SlotNumber INTEGER, AnswerText TEXT NOT NULL, AnswerPrefix TEXT, WasSelected INTEGER NOT NULL, WasCorrect INTEGER);
CREATE TABLE IF NOT EXISTS RunEvents (Id INTEGER PRIMARY KEY, ActivityRunId INTEGER NOT NULL REFERENCES ActivityRuns(Id), Timestamp TEXT NOT NULL, Level TEXT NOT NULL, EventType TEXT NOT NULL, Message TEXT NOT NULL);`);
    const answerColumns = this.db.prepare("PRAGMA table_info(Answers)").all() as Array<{ name: string }>;
    if (!answerColumns.some(column => column.name === "AnswerPrefix")) {
      this.db.exec("ALTER TABLE Answers ADD COLUMN AnswerPrefix TEXT");
    }
  }
}

type ListedCorrectAnswer = { answerText: string; slotNumber: number | null; answerPrefix?: string | null };

function parseListedCorrectAnswer(value: string): ListedCorrectAnswer {
  const answerText = value.replace(/\s+/g, " ").trim();
  const match = answerText.match(/^(\d+)\s*[.:-]?\s+(.+)$/);
  return match
    ? { slotNumber: Number(match[1]), answerText: match[2].trim() }
    : { slotNumber: null, answerText };
}

function normaliseAnswerText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}
function now(): string { return new Date().toISOString(); }
