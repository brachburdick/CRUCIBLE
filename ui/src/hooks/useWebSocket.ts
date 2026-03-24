import { useEffect, useRef, useState, useCallback } from 'react'

export interface WsMessage {
  type: 'event' | 'status_change'
  runId: string
  event: string
  data: Record<string, unknown>
  timestamp: string
}

function safeSend(ws: WebSocket | null, data: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data)
  }
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef<string[]>([])
  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState<WsMessage[]>([])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      // Flush any pending subscriptions
      for (const msg of pendingRef.current) {
        ws.send(msg)
      }
      pendingRef.current = []
    }
    ws.onclose = () => {
      setConnected(false)
    }
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WsMessage
        setMessages(prev => [...prev, msg])
      } catch { /* ignore */ }
    }

    return () => {
      ws.close()
    }
  }, [])

  const subscribe = useCallback((runId: string) => {
    const msg = JSON.stringify({ type: 'subscribe', runId })
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(msg)
    } else {
      pendingRef.current.push(msg)
    }
  }, [])

  const unsubscribe = useCallback((runId: string) => {
    safeSend(wsRef.current, JSON.stringify({ type: 'unsubscribe', runId }))
  }, [])

  const subscribeAll = useCallback(() => {
    const msg = JSON.stringify({ type: 'subscribe_all' })
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(msg)
    } else {
      pendingRef.current.push(msg)
    }
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
  }, [])

  return { connected, messages, subscribe, unsubscribe, subscribeAll, clearMessages }
}
