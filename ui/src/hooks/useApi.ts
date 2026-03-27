import { useState, useEffect, useCallback } from 'react'

export function useFetch<T>(url: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [url])

  useEffect(() => {
    refetch()
  }, [refetch, ...deps])

  return { data, loading, error, refetch }
}

export interface RunParams {
  taskFile?: string
  agent: string
  variant: string
  budget: number
  ttl: number
  // Project-based launch
  projectName?: string
  description?: string
  instructions?: string
  seedDir?: string
  systemPrompt?: string
}

export async function postRun(body: RunParams): Promise<{ runId?: string; message?: string }> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}
