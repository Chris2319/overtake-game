"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { WsClientAction, WsServerEvent } from "@/lib/game/types";

interface WsContextValue {
  connected: boolean;
  send: (data: WsClientAction) => void;
  subscribe: (fn: (data: WsServerEvent) => void) => () => void;
}

const WsContext = createContext<WsContextValue | null>(null);

interface WsProviderProps {
  children: React.ReactNode;
}

export function WsProvider({ children }: WsProviderProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<((data: WsServerEvent) => void)[]>([]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      const data: WsServerEvent = JSON.parse(e.data);
      listenersRef.current.forEach((fn) => fn(data));
    };

    return () => ws.close();
  }, []);

  const send = useCallback((data: WsClientAction) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error("[ws] send called while socket is not OPEN", { readyState: ws?.readyState, data });
      return;
    }
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error("[ws] send failed", err);
    }
  }, []);

  const subscribe = useCallback((fn: (data: WsServerEvent) => void) => {
    listenersRef.current.push(fn);
    return () => {
      listenersRef.current = listenersRef.current.filter((f) => f !== fn);
    };
  }, []);

  return <WsContext.Provider value={{ connected, send, subscribe }}>{children}</WsContext.Provider>;
}

export function useWs(): WsContextValue {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error("useWs must be used inside WsProvider");
  return ctx;
}
