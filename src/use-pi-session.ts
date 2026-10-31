import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import { PiCommandOutbox } from "./outbox";
import { EMPTY_VIEW, reduceEvents } from "./view";
import type {
  ClientMessage,
  ServerMessage,
  SessionView,
  ToolInfo
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

type State = SessionView & {
  readonly status: ConnectionStatus;
  /** Every registered tool, from the server's hello. */
  readonly catalog: readonly ToolInfo[];
};

const INITIAL_STATE: State = {
  ...EMPTY_VIEW,
  status: "connecting",
  catalog: []
};

/**
 * One pi session over the harness's WebSocket protocol, connected with
 * `useAgent`. The server sends pi's own agent events; this folds them with
 * the same `reduceEvents` the server tests use. A reconnect gets a fresh
 * snapshot, and the client sends again every submit whose answer the
 * socket never delivered; the harness deduplicates them by operation id, so
 * each runs once.
 */
/**
 * @param object  Durable Object 名（会话 UUID）。
 * @param branch  同一个对象里的 pi session id（分支）；省略为根会话。
 */
export function usePiSession(object: string, branch?: string) {
  const [state, setState] = useState<State>(INITIAL_STATE);
  // Unanswered submits, sent again each time the socket opens.
  const [outbox] = useState(() => new PiCommandOutbox());
  // Another object or branch starts from a clean slate.
  const key = `${object}:${branch ?? ""}`;
  const [stateKey, setStateKey] = useState(key);
  if (stateKey !== key) {
    setStateKey(key);
    setState(INITIAL_STATE);
  }

  const agent = useAgent({
    agent: "pi-agent",
    name: object,
    // 服务端 sockets.ts 按 ?session= 选 pi session。
    ...(branch ? { query: { session: branch } } : {}),
    onOpen: () => setState((current) => ({ ...current, status: "open" })),
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      outbox.receive(message);
      switch (message.type) {
        case "hello":
          setState((current) => ({ ...current, catalog: message.tools }));
          return;
        case "events":
          setState((current) => ({
            ...current,
            ...reduceEvents(current, message.events)
          }));
          return;
        case "error":
          setState((current) => ({ ...current, error: message.message }));
          return;
        default:
          return;
      }
    }
  });

  useEffect(() => {
    // Submits belong to the last object's session: never send them here.
    outbox.clear();
  }, [key, outbox]);

  useEffect(() => {
    if (state.status !== "open") return;
    outbox.sendPending((data) => agent.send(data));
  }, [state.status, agent, outbox]);

  const send = useCallback(
    (message: ClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
      }
    },
    [agent]
  );

  /**
   * Idle: starts a run. Busy: queued as a follow-up, or steers the run.
   * Kept in the outbox until answered, and sent again if the socket drops
   * first.
   */
  const submit = useCallback(
    (text: string, whenBusy: "followUp" | "steer" = "followUp") =>
      send(outbox.submit(text, whenBusy)),
    [send, outbox]
  );

  const abort = useCallback(
    () => send({ type: "abort", id: crypto.randomUUID() }),
    [send]
  );

  const reset = useCallback(
    () => send({ type: "reset", id: crypto.randomUUID() }),
    [send]
  );

  return { ...state, submit, abort, reset };
}
