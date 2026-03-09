import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { EChartsOption } from 'echarts'
import ReactECharts from 'echarts-for-react'
import './App.css'

interface UploadedFile {
  id: string
  file: File
  name: string
  type: 'word' | 'pdf' | 'other'
}

interface ApiResponse<T> {
  code: number
  message: string
  data: T | null
}

interface UploadedFileMeta {
  fileId: number
  fileName: string
  size: number
}

interface FileUploadResponse {
  fileIds: number[]
  files: UploadedFileMeta[]
}

interface GraphNode {
  id: number
  name: string
  type: string
  conflict: boolean
}

interface GraphEdge {
  id: number
  from: number
  to: number
  relation: string
  ratio?: string
  conflict: boolean
}

interface GraphConflict {
  id: number
  type: string
  description: string
}

interface GraphGenerateResponse {
  graphId: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  conflicts: GraphConflict[]
}

interface SourceItem {
  fileId: number
  fileName: string
  snippet: string
}

interface HighlightRange {
  start: number
  end: number
}

interface HighlightResponse {
  fileId: number
  fileName: string
  content: string
  highlightRanges?: HighlightRange[]
}

type TargetType = 'ENTITY' | 'RELATION' | 'CONFLICT'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

function toApiUrl(path: string): string {
  if (!API_BASE) return path
  return `${API_BASE.replace(/\/$/, '')}${path}`
}

async function requestApi<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(toApiUrl(path), init)
  const raw = await response.text()
  let payload: ApiResponse<T>

  try {
    payload = raw ? (JSON.parse(raw) as ApiResponse<T>) : ({ code: -1, message: 'Empty response', data: null } as ApiResponse<T>)
  } catch {
    throw new Error(`Non-JSON response received (${response.status})`)
  }

  if (!response.ok) {
    throw new Error(payload?.message || `HTTP ${response.status}`)
  }
  if (payload.code !== 0) {
    throw new Error(`[${payload.code}] ${payload.message}`)
  }
  if (payload.data === null) {
    throw new Error('API returned empty data')
  }

  return payload.data
}

function normalizeSources(payload: unknown): SourceItem[] {
  if (Array.isArray(payload)) return payload as SourceItem[]
  if (!payload || typeof payload !== 'object') return []

  const data = (payload as { data?: unknown }).data
  if (Array.isArray(data)) return data as SourceItem[]

  return []
}

function getFileType(file: File): UploadedFile['type'] {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (['doc', 'docx'].includes(ext)) return 'word'
  if (ext === 'pdf') return 'pdf'
  return 'other'
}

function getFileLabel(type: UploadedFile['type']) {
  switch (type) {
    case 'word': return 'W'
    case 'pdf': return 'P'
    default: return 'F'
  }
}

function truncateName(name: string, max = 12) {
  if (name.length <= max) return name
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  const base = name.slice(0, max - ext.length - 1)
  return `${base}…${ext}`
}

function App() {
  const [files, setFiles] = useState<UploadedFile[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [view, setView] = useState<'upload' | 'result'>('upload')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [highlightLoading, setHighlightLoading] = useState(false)
  const [error, setError] = useState('')

  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileMeta[]>([])
  const [graphData, setGraphData] = useState<GraphGenerateResponse | null>(null)
  const [selectedTargetLabel, setSelectedTargetLabel] = useState('')
  const [selectedSourceKey, setSelectedSourceKey] = useState('')
  const [sources, setSources] = useState<SourceItem[]>([])
  const [highlightDoc, setHighlightDoc] = useState<HighlightResponse | null>(null)
  const [fileContentMap, setFileContentMap] = useState<Map<number, string>>(new Map())
  const [activeFileId, setActiveFileId] = useState<number | null>(null)
  const historyCanvases = [
    { id: 'chart-4', name: 'Chart4', date: '2026/2/26' },
    { id: 'chart-3', name: 'Chart3', date: '2026/2/26' },
    { id: 'chart-2', name: 'Chart2', date: '2026/2/26' },
    { id: 'chart-1', name: 'Chart1', date: '2026/2/26' },
  ]

  const handleAddClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files
    if (!selected) return
    const newFiles: UploadedFile[] = Array.from(selected).map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      type: getFileType(file),
    }))
    setFiles((prev) => [...prev, ...newFiles])
    // reset so the same file can be selected again
    e.target.value = ''
  }

  const handleRemove = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const highlightRef = useRef<HTMLElement | null>(null)

  const handleLoadFileContent = async (fileId: number) => {
    setActiveFileId(fileId)
    // If already cached, show immediately
    const cached = fileContentMap.get(fileId)
    if (cached !== undefined) {
      const meta = uploadedFiles.find((f) => f.fileId === fileId)
      setHighlightDoc({ fileId, fileName: meta?.fileName || '', content: cached })
      return
    }
    // Fetch from backend (snippet is required, use empty placeholder — backend returns full content)
    setHighlightLoading(true)
    setHighlightDoc(null)
    try {
      const data = await requestApi<HighlightResponse>('/api/highlight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, snippet: '' }),
      })
      setHighlightDoc(data)
      // Cache the content
      setFileContentMap((prev) => new Map(prev).set(fileId, data.content))
      setError('')
    } catch (e) {
      console.warn('Failed to load file content', e)
      setHighlightDoc(null)
    } finally {
      setHighlightLoading(false)
    }
  }

  const handleFetchHighlight = async (source: SourceItem) => {
    setSelectedSourceKey(`${source.fileId}-${source.snippet}`)
    setHighlightLoading(true)

    try {
      const data = await requestApi<HighlightResponse>('/api/highlight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: source.fileId, snippet: source.snippet }),
      })
      setHighlightDoc(data)
      setError('')
      // scroll to first highlight after render
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 100)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch highlighted text')
      setHighlightDoc(null)
    } finally {
      setHighlightLoading(false)
    }
  }

  const handleFetchSources = async (targetType: TargetType, targetId: number, label: string) => {
    setSelectedTargetLabel(label)
    setSourceLoading(true)
    setSources([])
    setSelectedSourceKey('')
    setHighlightDoc(null)

    try {
      const query = new URLSearchParams({ targetType, targetId: String(targetId) }).toString()
      const data = await requestApi<unknown>(`/api/source?${query}`, { method: 'GET' })
      const list = normalizeSources(data)
      setSources(list)
      setError('')
      if (list.length > 0) {
        await handleFetchHighlight(list[0])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch source list')
    } finally {
      setSourceLoading(false)
    }
  }

  const handleConfirm = async () => {
    if (files.length === 0) return
    setIsSubmitting(true)
    setError('')

    try {
      const formData = new FormData()
      files.forEach((f) => formData.append('files', f.file))

      const uploaded = await requestApi<FileUploadResponse>('/api/files/upload', {
        method: 'POST',
        body: formData,
      })

      if (!uploaded.fileIds?.length) {
        throw new Error('Upload succeeded but fileIds is empty')
      }

      const generated = await requestApi<GraphGenerateResponse>('/api/graph/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: uploaded.fileIds }),
      })

      setUploadedFiles(uploaded.files || [])
      setGraphData(generated)
      setSources([])
      setSelectedTargetLabel('')
      setSelectedSourceKey('')
      setHighlightDoc(null)
      setFileContentMap(new Map())
      setView('result')

      // Auto-load first file content from backend
      if (uploaded.files?.length > 0) {
        void handleLoadFileContent(uploaded.files[0].fileId)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate graph')
    } finally {
      setIsSubmitting(false)
    }
  }

  const chartOptions = useMemo(() => {
    if (!graphData) return {}

    const categories = Array.from(new Set(graphData.nodes.map((n) => n.type))).map((type) => ({ name: type }))
    const typeToColor = new Map(
      categories.map((c, index) => [c.name, ['#e8f4ff', '#eaf7ee', '#fff4e8', '#eef2ff'][index % 4]])
    )

    const nodeData = graphData.nodes.map((node) => ({
      id: String(node.id),
      name: node.name,
      value: node.type,
      category: categories.findIndex((c) => c.name === node.type),
      symbolSize: node.conflict ? 56 : 50,
      itemStyle: {
        color: node.conflict ? '#fff1f0' : typeToColor.get(node.type) || '#e8f4ff',
        borderColor: node.conflict ? '#cf1322' : '#168cff',
        borderWidth: node.conflict ? 2.4 : 1.2,
      },
      label: {
        show: true,
        color: '#1a1a1a',
        fontSize: 12,
      },
    }))

    const links = graphData.edges.map((edge) => {
      const edgeText = edge.ratio ? `${edge.relation} ${edge.ratio}` : edge.relation
      return {
        id: String(edge.id),
        source: String(edge.from),
        target: String(edge.to),
        value: 1,
        name: edgeText,
        lineStyle: {
          width: edge.conflict ? 2.4 : 1.4,
          color: edge.conflict ? '#d93025' : '#7f8ea3',
          type: edge.conflict ? 'dashed' : 'solid',
          opacity: 0.95,
        },
        label: {
          show: true,
          formatter: edgeText,
          color: edge.conflict ? '#b42318' : '#4b5563',
          fontSize: 11,
          backgroundColor: '#ffffff',
          borderRadius: 4,
          padding: [2, 5],
        },
      }
    })

    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const p = params as { dataType?: string; data?: { name?: string; value?: string; id?: string } }
          if (p.dataType === 'edge') return p.data?.name || 'Relation'
          if (p.dataType === 'node') return `${p.data?.name || ''}<br/>Type: ${p.data?.value || '-'}`
          return ''
        },
      },
      legend: {
        show: true,
        top: 10,
      },
      series: [
        {
          type: 'graph',
          layout: 'force',
          data: nodeData,
          links,
          categories,
          roam: true,
          draggable: true,
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: [4, 10],
          force: {
            repulsion: 900,
            edgeLength: [140, 240],
            gravity: 0.06,
            friction: 0.2,
          },
          lineStyle: {
            curveness: 0.08,
          },
          emphasis: {
            focus: 'adjacency',
            lineStyle: {
              width: 3,
            },
          },
        },
      ],
    }
  }, [graphData]) as EChartsOption

  const chartEvents = {
    click: (params: { dataType?: string; data?: { id?: string; name?: string; value?: string } }) => {
      if (!graphData || !params.dataType) return

      if (params.dataType === 'node' && params.data?.id) {
        const id = Number(params.data.id)
        if (!Number.isNaN(id)) {
          void handleFetchSources('ENTITY', id, `Entity: ${params.data.name || id}`)
        }
      }

      if (params.dataType === 'edge' && params.data?.id) {
        const id = Number(params.data.id)
        const edge = graphData.edges.find((item) => item.id === id)
        if (!Number.isNaN(id)) {
          const label = edge ? `Relation: ${edge.relation}${edge.ratio ? ` ${edge.ratio}` : ''}` : `Relation ID: ${id}`
          void handleFetchSources('RELATION', id, label)
        }
      }
    },
  }

  const renderHighlightedContent = () => {
    if (!highlightDoc) {
      return highlightLoading
        ? 'Loading...'
        : 'Select a graph node/relation on the left, or click a file tab above to view full content.'
    }

    const { content, highlightRanges } = highlightDoc

    // No ranges — show full text as-is
    if (!highlightRanges || highlightRanges.length === 0) {
      return content
    }

    // Sort ranges by start position
    const sorted = [...highlightRanges].sort((a, b) => a.start - b.start)
    const fragments: ReactNode[] = []
    let cursor = 0
    let firstRef = true

    sorted.forEach((range, index) => {
      const start = Math.max(range.start, cursor)
      const end = Math.min(range.end, content.length)
      if (start > end) return

      // Text before highlight
      if (cursor < start) {
        fragments.push(content.slice(cursor, start))
      }

      // Highlighted segment
      fragments.push(
        <mark
          key={`hl-${index}`}
          className="snippet-mark"
          ref={firstRef ? (el) => { highlightRef.current = el } : undefined}
        >
          {content.slice(start, end)}
        </mark>
      )
      firstRef = false
      cursor = end
    })

    // Remaining text
    if (cursor < content.length) {
      fragments.push(content.slice(cursor))
    }

    return fragments
  };

  if (view === 'result' && graphData) {
    return (
      <div className="result-view-container">
        <div className="result-top-nav">
          <div className="result-nav-brand">Evidence Link</div>
          <div className="history-canvas-nav">
            {historyCanvases.map((canvas) => (
              <div className="history-canvas-item" key={canvas.id}>
                <div className="canvas-item-head">
                  <span className="canvas-star">✦</span>
                  <span className="canvas-name">{canvas.name}</span>
                  <span className="canvas-date">{canvas.date}</span>
                </div>
                <div className="canvas-actions">
                  <button type="button" className="canvas-action-btn">Edit</button>
                  <button type="button" className="canvas-action-btn">Copy</button>
                  <button type="button" className="canvas-action-btn">Delete</button>
                </div>
              </div>
            ))}
            <button className="canvas-add-btn" type="button" aria-label="Add history canvas">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M7 1V13M1 7H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <button className="back-link nav-back-link" onClick={() => setView('upload')} aria-label="Back to upload">
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 13L1 7M1 7L6 1M1 7H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <div className="result-main">
          <div className="chart-panel">
            <div className="panel-header chart-header">
              <span className="graph-meta">Graph #{graphData.graphId}</span>
            </div>
            <div className="chart-content" style={{ padding: 0, overflow: 'hidden' }}>
              <ReactECharts option={chartOptions} onEvents={chartEvents} style={{ height: '100%', width: '100%' }} />
            </div>
            <div className="conflict-panel">
              <div className="conflict-title">Conflict Detected</div>
              {graphData.conflicts.length === 0 && <div className="conflict-empty">There are no conflicts detected.</div>}
              {graphData.conflicts.map((conflict) => (
                <button
                  key={conflict.id}
                  className="conflict-item"
                  onClick={() => void handleFetchSources('CONFLICT', conflict.id, `Conflict: ${conflict.description}`)}
                >
                  <span className="conflict-type">{conflict.type}</span>
                  <span>{conflict.description}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="doc-panel">
            <div className="panel-header doc-header">
              <div className="doc-target">
                <div className="doc-target-title">Current Source Target</div>
                <div className="doc-target-value">{selectedTargetLabel || 'Not selected'}</div>
              </div>
              <div className="source-count">{sourceLoading ? 'Loading sources...' : `${sources.length} source(s)`}</div>
            </div>
            <div className="source-toolbar">
              {sources.length > 0
                ? sources.map((source) => {
                    const key = `${source.fileId}-${source.snippet}`
                    return (
                      <button
                        key={key}
                        className={`source-pill ${selectedSourceKey === key ? 'active' : ''}`}
                        onClick={() => void handleFetchHighlight(source)}
                      >
                        {source.fileName}
                      </button>
                    )
                  })
                : uploadedFiles.map((uf) => (
                    <button
                      key={uf.fileId}
                      className={`source-pill ${activeFileId === uf.fileId ? 'active' : ''}`}
                      onClick={() => void handleLoadFileContent(uf.fileId)}
                    >
                      {uf.fileName}
                    </button>
                  ))}
            </div>
            <div className="doc-content-wrapper">
              <div className="doc-paper">
                <h2 className="doc-title">{highlightDoc?.fileName || 'Document Preview'}</h2>
                <div className="doc-meta">
                  {highlightLoading && <span>Loading text...</span>}
                </div>
                <div className="doc-body">
                  <p>{renderHighlightedContent()}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-container">
      <header className="evidence-header">
        <h1>Evidence Link</h1>
      </header>

      <main className="main-content">
        <h2 className="main-title">Try to import your files. Let's explore.</h2>

        <div className="import-card">
          <div className="card-top-bar">
            <span className="card-hint">Let's start from importing files.</span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".doc,.docx,.pdf,.txt,.xlsx,.xls,.pptx,.ppt"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <button className="icon-btn plus-btn" aria-label="Add file" onClick={handleAddClick}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M7 1V13M1 7H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="file-items">
            {files.length === 0 && (
              <span className="file-empty-hint">No files selected</span>
            )}
            {files.map((f) => (
              <div className="file-item" key={f.id}>
                <div className={`file-icon ${f.type === 'word' ? 'word-bg' : f.type === 'pdf' ? 'pdf-bg' : 'other-bg'}`}>
                  <div className={`doc-letter ${f.type === 'word' ? 'word-letter' : f.type === 'pdf' ? 'pdf-letter' : 'other-letter'}`}>
                    {getFileLabel(f.type)}
                  </div>
                </div>
                <span className="file-name" title={f.name}>{truncateName(f.name)}</span>
                <button className="remove-item-btn" aria-label="Remove file" onClick={() => handleRemove(f.id)}>
                  <svg width="6" height="6" viewBox="0 0 8 8" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 1L7 7M7 1L1 7" stroke="#777" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          <div className="card-actions">
            <button className="confirm-btn" onClick={() => void handleConfirm()} disabled={files.length === 0 || isSubmitting}>
              {isSubmitting ? 'PROCESSING...' : 'CONFIRM'}
            </button>
          </div>
          {error && <div className="error-message">{error}</div>}
        </div>
      </main>

      <div className="chat-widget">
        <div className="widget-header">
          <SparkleIcon />
          <span className="widget-text">What do you want to know ?</span>
        </div>
        <div className="widget-toolbar">
          <button className="tool-btn mic-btn" aria-label="Voice input">
            <svg width="10" height="14" viewBox="0 0 12 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 1V9M3 3C3 1.34315 4.34315 0 6 0C7.65685 0 9 1.34315 9 3V7C9 8.65685 7.65685 10 6 10C4.34315 10 3 8.65685 3 7V3Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M1 7v1a5 5 0 0 0 10 0V7M6 13v3m-2.5 0h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button className="tool-btn send-btn" aria-label="Send message">
            <svg width="10" height="12" viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 13V1M6 1L1 6M6 1L11 6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

function SparkleIcon() {
  return (
    <svg className="sparkle-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7.99992 1.33331L8.94966 5.86178L13.3333 6.66665L8.94966 7.47151L7.99992 12L7.05018 7.47151L2.6665 6.66665L7.05018 5.86178L7.99992 1.33331Z" fill="#168CFF" />
      <path d="M12.6666 10.6666L13.1414 12.9309L15.3333 13.3333L13.1414 13.7357L12.6666 16L12.1917 13.7357L9.99984 13.3333L12.1917 12.9309L12.6666 10.6666Z" fill="#168CFF" />
    </svg>
  )
}

export default App
