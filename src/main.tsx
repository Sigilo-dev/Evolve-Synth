import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

type EngineState = "IDLE" | "BROWSER_READY" | "ACTIVITY_DETECTED" | "OBSERVING" | "RUNNING" | "DETECTING_SCREEN" | "ANSWERING" | "VERIFYING" | "CHECKING" | "RECORDING" | "ADVANCING" | "FINISHED" | "STOPPED" | "ERROR" | "UNSUPPORTED";
type RunSummary = { id: number; startedAt: string; status: string; screensProcessed: number };
type CorrectScreen = { screenNumber: number | null; question: string; answers: string[]; answerPrefixes?: Array<string | null>; interactionType?: string };
type Report = { started_at: string; screens: Array<{ screen_number: number | null; interaction_type: string; question: string; correct_answers: string[]; correct_answer_prefixes?: Array<string | null> }> };
type StatusPayload = { state: EngineState; message: string; details?: Record<string, unknown> };

const defaultBlackboardUrl = "https://aulavirtual.upc.edu.pe/ultra/course";
const runningStates: EngineState[] = ["OBSERVING", "RUNNING", "DETECTING_SCREEN", "ANSWERING", "VERIFYING", "CHECKING", "RECORDING", "ADVANCING"];

function useEngineStatus(initial: StatusPayload) {
  const [status, setStatus] = useState(initial);
  useEffect(() => {
    let off: (() => void) | undefined;
    listen<StatusPayload>("engine-status", event => setStatus(event.payload)).then(value => { off = value; });
    return () => off?.();
  }, []);
  return [status, setStatus] as const;
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function missingText(answer: string, prefix: string | null | undefined): string | undefined {
  if (prefix === null || prefix === undefined) return undefined;
  // Cambridge labels multi-gap feedback as "1 answer", "2 answer", etc.
  // That number is useful in the display but must never reach the clipboard.
  const copySource = answer.replace(/^\d+\s*[.:-]?\s+/, "");
  const initial = prefix.trim();
  if (!initial) return copySource;
  return copySource.toLocaleLowerCase().startsWith(initial.toLocaleLowerCase()) ? copySource.slice(initial.length) : copySource;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

function CaptureCard({ screen, index, captureRef }: { screen: CorrectScreen; index: number; captureRef?: (element: HTMLElement | null) => void }) {
  const [copiedAnswer, setCopiedAnswer] = useState<number | undefined>();
  async function copyMissing(answer: string, answerIndex: number): Promise<void> {
    const missing = missingText(answer, screen.answerPrefixes?.[answerIndex]);
    if (missing === undefined || !missing) return;
    await copyToClipboard(missing);
    setCopiedAnswer(answerIndex);
    window.setTimeout(() => setCopiedAnswer(current => current === answerIndex ? undefined : current), 1_200);
  }
  return <article className="question-card" ref={captureRef}>
    <div className="question-meta"><span>PREGUNTA {screen.screenNumber ?? index + 1}</span></div>
    {screen.question && <p className="question-text">{screen.question}</p>}
    <div className="answer-list">{screen.answers.map((answer, answerIndex) => {
      const missing = missingText(answer, screen.answerPrefixes?.[answerIndex]);
      return <div className="answer-row" key={`${answer}-${answerIndex}`}>
        <strong>{answer}</strong>
        {missing ? <button className="copy-missing" type="button" title={`Copiar: ${missing}`} onClick={() => void copyMissing(answer, answerIndex)}>{copiedAnswer === answerIndex ? "Copiado" : `Copiar ${missing}`}</button> : null}
      </div>;
    })}</div>
  </article>;
}

function CaptureBar({ observing, busy, onToggle }: { observing: boolean; busy: boolean; onToggle: () => void }) {
  return <section className="capture-area">
    <button className={`capture-bar ${observing ? "is-recording" : ""}`} disabled={busy} onClick={onToggle}>
      <span className="record-dot" aria-hidden="true" />
      <span>{observing ? "Detener y guardar" : "Iniciar captura"}</span>
      <small>Ctrl + Shift + O</small>
    </button>
    <p>{observing ? "Grabando solo las respuestas confirmadas por Cambridge." : "La barra esta al final: nunca tapa el contenido."}</p>
  </section>;
}

function Controller() {
  const [status, setStatus] = useEngineStatus({ state: "IDLE", message: "Ready" });
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [report, setReport] = useState<Report | undefined>();
  const [view, setView] = useState<"history" | "detail">("history");
  const [menuOpen, setMenuOpen] = useState(false);
  const firstCardRef = useRef<HTMLElement | null>(null);
  const lastCardRef = useRef<HTMLElement | null>(null);
  const previouslyObserving = useRef(false);

  const observing = status.state === "OBSERVING";
  const correctScreens = (status.details?.correctScreens as CorrectScreen[] | undefined) ?? [];
  const detailScreens: CorrectScreen[] = report
    ? report.screens.map(screen => ({ screenNumber: screen.screen_number, interactionType: screen.interaction_type, question: screen.question, answers: screen.correct_answers, answerPrefixes: screen.correct_answer_prefixes }))
    : correctScreens;
  const detailDate = report?.started_at ?? (status.details?.summary as { startedAt?: string } | undefined)?.startedAt ?? new Date().toISOString();

  useEffect(() => {
    void invoke<StatusPayload>("open_platform", { url: defaultBlackboardUrl, browserPreference: "Chrome, then Edge" })
      .then(setStatus)
      .catch(error => setStatus({ state: "ERROR", message: String(error) }));
  }, [setStatus]);

  useEffect(() => {
    if (!runningStates.includes(status.state)) return;
    const refresh = () => void invoke<StatusPayload>("get_run_status").then(setStatus).catch(error => setStatus({ state: "ERROR", message: String(error) }));
    const timer = window.setInterval(refresh, 750);
    return () => window.clearInterval(timer);
  }, [status.state, setStatus]);

  async function refreshHistory() {
    const result = await invoke<StatusPayload>("list_runs");
    setRuns((result.details?.runs as RunSummary[]) ?? []);
  }
  useEffect(() => { void refreshHistory(); }, []);
  useEffect(() => { if (status.state === "FINISHED") void refreshHistory(); }, [status.state]);

  useEffect(() => {
    if (observing) {
      previouslyObserving.current = true;
      setView("detail");
      lastCardRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else if (status.state === "FINISHED" && previouslyObserving.current) {
      previouslyObserving.current = false;
      firstCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [observing, status.state, correctScreens.length]);

  async function toggleCapture() {
    setBusy(true);
    try {
      const result = await invoke<StatusPayload>("toggle_observation");
      setStatus(result);
      if (result.state === "OBSERVING") { setReport(undefined); setView("detail"); }
    } catch (error) { setStatus({ state: "ERROR", message: String(error) }); }
    finally { setBusy(false); }
  }

  async function openRun(run: RunSummary) {
    setBusy(true);
    try {
      const result = await invoke<StatusPayload>("get_run", { runId: run.id });
      setReport(result.details?.report as Report);
      setView("detail");
    } catch (error) { setStatus({ state: "ERROR", message: String(error) }); }
    finally { setBusy(false); }
  }

  async function clearHistory() {
    setMenuOpen(false);
    if (!window.confirm("Se eliminaran todas las capturas guardadas. Deseas continuar?")) return;
    setBusy(true);
    try {
      await invoke<StatusPayload>("clear_history");
      setRuns([]);
      setReport(undefined);
      setView("history");
    } catch (error) { setStatus({ state: "ERROR", message: String(error) }); }
    finally { setBusy(false); }
  }

  function closeApp() {
    setMenuOpen(false);
    void invoke("close_app").catch(error => setStatus({ state: "ERROR", message: String(error) }));
  }

  const hasLiveCapture = observing || (status.state === "FINISHED" && correctScreens.length > 0 && !report);
  const showDetail = view === "detail" && (Boolean(report) || hasLiveCapture);

  return <main className="capture-shell">
    <header className="capture-header">
      <div className="window-drag-surface" data-tauri-drag-region aria-hidden="true" />
      {showDetail ? <button className="icon-button" aria-label="Volver al historial" onClick={() => { setView("history"); setReport(undefined); }}>&#8592;</button> : <div className="brand"><h1>Evolve Synth</h1><span>Captura manual</span></div>}
      {showDetail && <div className="detail-heading"><h1>{dateTime(detailDate)}</h1><span>{detailScreens.length} preguntas capturadas</span></div>}
      <div className="menu-wrap"><button className="icon-button menu-button" aria-label="Abrir menu" onClick={() => setMenuOpen(value => !value)}>&#8942;</button>{menuOpen && <div className="menu"><button onClick={() => void clearHistory()} disabled={observing || busy}>Limpiar historial</button><button onClick={closeApp}>Cerrar app</button></div>}</div>
    </header>

    {status.state === "ERROR" && <p className="inline-error">{status.message}</p>}

    {showDetail ? <>
      <section className="questions" aria-live="polite">
        {detailScreens.length === 0 && <p className="empty-copy">Esperando la primera respuesta correcta confirmada.</p>}
        {detailScreens.map((screen, index) => <CaptureCard key={`${screen.screenNumber ?? "?"}-${index}-${screen.question}`} screen={screen} index={index} captureRef={element => { if (index === 0) firstCardRef.current = element; if (index === detailScreens.length - 1) lastCardRef.current = element; }} />)}
      </section>
      <CaptureBar observing={observing} busy={busy} onToggle={() => void toggleCapture()} />
    </> : <>
      <CaptureBar observing={observing} busy={busy} onToggle={() => void toggleCapture()} />
      <section className="history-intro"><span>HISTORIAL</span><h2>Capturas recientes</h2><p>Selecciona una sesion para revisar todas las preguntas y las respuestas correctas capturadas.</p></section>
      <section className="history-list">
        {runs.length === 0 ? <p className="empty-copy">No hay capturas guardadas todavia.</p> : runs.map(run => <button className="history-card" key={run.id} disabled={busy} onClick={() => void openRun(run)}><strong>{dateTime(run.startedAt)}</strong><span>{run.screensProcessed} preguntas capturadas</span></button>)}
      </section>
    </>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Controller />);
