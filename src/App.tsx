import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { EChartsOption } from 'echarts'
import ReactECharts from 'echarts-for-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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

interface ConflictPreview {
  sources: SourceItem[]
  loading: boolean
  error?: string
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

interface TimelineEntry {
  id: string
  date: string
  text: string
}

interface GraphTimelineItem {
  relationId: number
  date: string
  text: string
}

interface GraphTimelineResponse {
  graphId: number
  items: GraphTimelineItem[]
}

interface CopilotMessage {
  id: string
  role: 'assistant' | 'user'
  content: string
  timestamp: string
}

type TargetType = 'ENTITY' | 'RELATION' | 'CONFLICT'
type UnknownRecord = Record<string, unknown>

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

function createTimestamp() {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
}

async function askGemini(message: string): Promise<string> {
  const response = await fetch(toApiUrl('/api/chat'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  })

  const raw = await response.text()
  let payload: { message?: string; error?: string } = {}

  if (raw) {
    try {
      payload = JSON.parse(raw) as { message?: string; error?: string }
    } catch {
      throw new Error(raw)
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`)
  }

  const text = payload.message?.trim()
  if (!text) {
    throw new Error('Chat API returned an empty response')
  }

  return text
}

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

async function requestFlexibleApi(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(toApiUrl(path), init)
  const raw = await response.text()

  let parsed: unknown = raw
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = raw
    }
  }

  if (!response.ok) {
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      throw new Error(String((parsed as UnknownRecord).message))
    }
    throw new Error(`HTTP ${response.status}`)
  }

  if (parsed && typeof parsed === 'object' && 'code' in parsed) {
    const payload = parsed as ApiResponse<unknown>
    if (payload.code !== 0) {
      throw new Error(`[${payload.code}] ${payload.message}`)
    }
    return payload.data
  }

  return parsed
}

function normalizeSources(payload: unknown): SourceItem[] {
  if (Array.isArray(payload)) return payload as SourceItem[]
  if (!payload || typeof payload !== 'object') return []

  const data = (payload as { data?: unknown }).data
  if (Array.isArray(data)) return data as SourceItem[]

  return []
}

function getNestedValue(payload: unknown, keys: string[]): unknown {
  if (!payload || typeof payload !== 'object') return undefined

  const record = payload as UnknownRecord
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null) return value
  }

  if ('data' in record) {
    return getNestedValue(record.data, keys)
  }

  return undefined
}

function normalizeSummary(payload: unknown, fallbackCount = 0): string {
  if (typeof payload === 'string') {
    const summary = payload.trim()
    return summary || `共 ${fallbackCount} 个来源文件`
  }

  if (typeof payload === 'number') {
    return `共 ${payload} 个来源文件`
  }

  const textValue = getNestedValue(payload, ['summary', 'content', 'text', 'description', 'message'])
  if (typeof textValue === 'string' && textValue.trim()) {
    return textValue.trim()
  }

  const countValue = getNestedValue(payload, ['sourceFileCount', 'fileCount', 'count', 'total'])
  if (typeof countValue === 'number') {
    return `共 ${countValue} 个来源文件`
  }

  return `共 ${fallbackCount} 个来源文件`
}

function normalizeFileContent(payload: unknown, fileId: number, fallbackName: string): HighlightResponse {
  if (typeof payload === 'string') {
    return { fileId, fileName: fallbackName, content: payload }
  }

  const content = getNestedValue(payload, ['content', 'text', 'body'])
  const fileName = getNestedValue(payload, ['fileName', 'name'])
  const resolvedFileId = getNestedValue(payload, ['fileId', 'id'])

  return {
    fileId: typeof resolvedFileId === 'number' ? resolvedFileId : fileId,
    fileName: typeof fileName === 'string' && fileName.trim() ? fileName : fallbackName,
    content: typeof content === 'string' ? content : '',
  }
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

function formatConflictType(type: string) {
  return type
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function getConflictSubtitle(conflict: GraphConflict, sources: SourceItem[]) {
  const fileNames = Array.from(new Set(sources.map((source) => source.fileName).filter(Boolean)))
  const sourceLabel = fileNames.length > 0 ? `Sources: ${fileNames.join(' / ')}` : 'Sources unavailable'
  return `${formatConflictType(conflict.type)} · ${sourceLabel}`
}


function App() {
  const [files, setFiles] = useState<UploadedFile[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chartPanelRef = useRef<HTMLDivElement>(null)
  const sidePanelRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'upload' | 'result'>('upload')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [highlightLoading, setHighlightLoading] = useState(false)
  const [error, setError] = useState('')

  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileMeta[]>([])
  const [graphData, setGraphData] = useState<GraphGenerateResponse | null>(null)
  const [selectedTargetLabel, setSelectedTargetLabel] = useState('')
  const [summaryText, setSummaryText] = useState('')
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [isEvidenceBadgeVisible, setIsEvidenceBadgeVisible] = useState(false)
  const [sources, setSources] = useState<SourceItem[]>([])
  const [highlightDoc, setHighlightDoc] = useState<HighlightResponse | null>(null)
  const [fileContentMap, setFileContentMap] = useState<Map<number, string>>(new Map())

  const [conflictPreviewMap, setConflictPreviewMap] = useState<Record<number, ConflictPreview>>({})
  const [conflictPanelHeight, setConflictPanelHeight] = useState(260)
  const [documentCardHeight, setDocumentCardHeight] = useState(312)
  const [timelineCardHeight, setTimelineCardHeight] = useState(208)
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [copilotInput, setCopilotInput] = useState('')
  const [isCopilotSubmitting, setIsCopilotSubmitting] = useState(false)
  const [copilotMessages, setCopilotMessages] = useState<CopilotMessage[]>([])
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
      const meta = uploadedFiles.find((f) => f.fileId === fileId)
      const data = await requestFlexibleApi(`/api/files/content?fileId=${fileId}`, {
        method: 'GET',
      })
      const document = normalizeFileContent(data, fileId, meta?.fileName || '')
      setHighlightDoc(document)
      // Cache the content
      setFileContentMap((prev) => new Map(prev).set(fileId, document.content))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load file content')
      setHighlightDoc(null)
    } finally {
      setHighlightLoading(false)
    }
  }

  const handleFetchHighlight = async (source: SourceItem) => {
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

  const handleFetchSources = async (
    targetType: TargetType,
    targetId: number,
    label: string,
    preferredSourceIndex = 0
  ) => {
    setSelectedTargetLabel(label)
    setSummaryLoading(true)
    setSummaryText('')
    setIsEvidenceBadgeVisible(true)
    setSources([])
    setHighlightDoc(null)

    const query = new URLSearchParams({ targetType, targetId: String(targetId) }).toString()

    try {
      const [sourcesResult, summaryResult] = await Promise.allSettled([
        requestApi<unknown>(`/api/source?${query}`, { method: 'GET' }),
        requestFlexibleApi('/api/evidence/summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetType, targetId }),
        }),
      ])

      let list: SourceItem[] = []
      if (sourcesResult.status === 'fulfilled') {
        list = normalizeSources(sourcesResult.value)
        setSources(list)
      } else {
        throw sourcesResult.reason
      }

      const sourceFileCount = new Set(list.map((item) => item.fileId)).size
      if (summaryResult.status === 'fulfilled') {
        setSummaryText(normalizeSummary(summaryResult.value, sourceFileCount))
      } else {
        setSummaryText(`共 ${sourceFileCount} 个来源文件`)
      }

      setError('')
      if (list.length > 0) {
        const targetSource = list[preferredSourceIndex] || list[0]
        await handleFetchHighlight(targetSource)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch source list')
      setSummaryText('')
    } finally {
      setSummaryLoading(false)
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
      setSummaryText('')
      setIsEvidenceBadgeVisible(false)
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

  const dynamicCategories = useMemo(() => {
    if (!graphData) return []
    return Array.from(new Set(graphData.nodes.map((n) => n.type)))
  }, [graphData])

  const ECHARTS_PALETTE = [
    '#5470c6',
    '#91cc75',
    '#fac858',
    '#ee6666',
    '#73c0de',
    '#3ba272',
    '#fc8452',
    '#9a60b4',
    '#ea7ccc',
  ]

  const chartOptions = useMemo(() => {
    if (!graphData) return {}

    const categories = dynamicCategories.map((type) => ({ name: type }))
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
        show: false,
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
  }, [dynamicCategories, graphData]) as EChartsOption

  const evidenceSourceFiles = useMemo(
    () => Array.from(new Map(sources.map((source) => [source.fileId, source.fileName])).entries())
      .map(([fileId, fileName]) => ({ fileId, fileName })),
    [sources]
  )

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

  const renderEvidenceBadgeRows = () => {
    if (summaryLoading) {
      return Array.from({ length: 4 }).map((_, index) => (
        <div
          key={`loading-${index}`}
          className={`badge-loading-bar ${index % 2 === 1 ? 'wide' : ''}`}
        />
      ))
    }

    const visibleFiles = evidenceSourceFiles.slice(0, 4)
    if (visibleFiles.length === 0) return null

    return (
      <>
        {visibleFiles.map((item) => (
          <div key={item.fileId} className="badge-source-row" title={item.fileName}>
            <span>{item.fileName}</span>
          </div>
        ))}
        {evidenceSourceFiles.length > visibleFiles.length && (
          <div className="badge-more-row">+{evidenceSourceFiles.length - visibleFiles.length} more</div>
        )}
      </>
    )
  }

  const handleConflictAction = async (conflict: GraphConflict, preferredSourceIndex = 0) => {
    await handleFetchSources(
      'CONFLICT',
      conflict.id,
      `Conflict: ${conflict.description}`,
      preferredSourceIndex
    )
  }

  const handleCopilotSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = copilotInput.trim()
    if (!message || isCopilotSubmitting) return

    const userTimestamp = createTimestamp()
    setCopilotMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: message,
        timestamp: userTimestamp,
      },
    ])
    setCopilotInput('')

    const focusLabel = selectedTargetLabel || highlightDoc?.fileName || '图谱总览'
    const prompt = [
      '你是 Evidence Link 的 Copilot。',
      '请基于当前工作上下文回答用户。',
      `当前焦点: ${focusLabel}`,
      '',
      `用户问题: ${message}`,
    ].join('\n')

    setIsCopilotSubmitting(true)

    try {
      const reply = await askGemini(prompt)
      setCopilotMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: reply,
          timestamp: createTimestamp(),
        },
      ])
    } catch (requestError) {
      setCopilotMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: requestError instanceof Error ? requestError.message : 'Gemini request failed',
          timestamp: createTimestamp(),
        },
      ])
    } finally {
      setIsCopilotSubmitting(false)
    }
  }

  const handleSidePanelResizeStart = (
    target: 'document' | 'timeline',
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    const sidePanel = sidePanelRef.current
    if (!sidePanel) return

    event.preventDefault()

    const startY = event.clientY
    const startDocumentHeight = documentCardHeight
    const startTimelineHeight = timelineCardHeight
    const panelRect = sidePanel.getBoundingClientRect()
    const splitterSpace = 24
    const minDocumentHeight = 220
    const minTimelineHeight = 148
    const minCopilotHeight = 220

    const nextPointerId = event.pointerId
    event.currentTarget.setPointerCapture(nextPointerId)
    document.body.classList.add('is-resizing-side-panel')

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaY = moveEvent.clientY - startY

      if (target === 'document') {
        const maxDocumentHeight = Math.max(
          minDocumentHeight,
          panelRect.height - startTimelineHeight - minCopilotHeight - splitterSpace
        )
        const nextDocumentHeight = Math.min(
          maxDocumentHeight,
          Math.max(minDocumentHeight, startDocumentHeight + deltaY)
        )
        setDocumentCardHeight(nextDocumentHeight)
        return
      }

      const maxTimelineHeight = Math.max(
        minTimelineHeight,
        panelRect.height - startDocumentHeight - minCopilotHeight - splitterSpace
      )
      const nextTimelineHeight = Math.min(
        maxTimelineHeight,
        Math.max(minTimelineHeight, startTimelineHeight + deltaY)
      )
      setTimelineCardHeight(nextTimelineHeight)
    }

    const handlePointerEnd = () => {
      document.body.classList.remove('is-resizing-side-panel')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
  }

  const handleConflictResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const chartPanel = chartPanelRef.current
    if (!chartPanel) return

    event.preventDefault()

    const startY = event.clientY
    const startHeight = conflictPanelHeight
    const panelRect = chartPanel.getBoundingClientRect()
    const minHeight = 156
    const maxHeight = Math.max(minHeight, panelRect.height - 220)

    const nextPointerId = event.pointerId
    event.currentTarget.setPointerCapture(nextPointerId)
    document.body.classList.add('is-resizing-conflict-panel')

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaY = startY - moveEvent.clientY
      const nextHeight = Math.min(maxHeight, Math.max(minHeight, startHeight + deltaY))
      setConflictPanelHeight(nextHeight)
    }

    const handlePointerEnd = () => {
      document.body.classList.remove('is-resizing-conflict-panel')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
  }

  useEffect(() => {
    if (!graphData?.conflicts.length) {
      setConflictPreviewMap({})
      return
    }

    let isCancelled = false

    setConflictPreviewMap(
      Object.fromEntries(
        graphData.conflicts.map((conflict) => [
          conflict.id,
          { sources: [], loading: true } satisfies ConflictPreview,
        ])
      )
    )

    void Promise.all(
      graphData.conflicts.map(async (conflict) => {
        try {
          const query = new URLSearchParams({ targetType: 'CONFLICT', targetId: String(conflict.id) }).toString()
          const payload = await requestApi<unknown>(`/api/source?${query}`, { method: 'GET' })
          return {
            id: conflict.id,
            preview: {
              sources: normalizeSources(payload),
              loading: false,
            } satisfies ConflictPreview,
          }
        } catch (e) {
          return {
            id: conflict.id,
            preview: {
              sources: [],
              loading: false,
              error: e instanceof Error ? e.message : 'Failed to load conflict preview',
            } satisfies ConflictPreview,
          }
        }
      })
    ).then((previews) => {
      if (isCancelled) return

      setConflictPreviewMap(
        Object.fromEntries(previews.map((item) => [item.id, item.preview]))
      )
    })

    return () => {
      isCancelled = true
    }
  }, [graphData])

  useEffect(() => {
    if (!graphData?.graphId) {
      setTimelineEntries([])
      setTimelineError('')
      setTimelineLoading(false)
      return
    }

    let isCancelled = false
    setTimelineLoading(true)
    setTimelineError('')

    void requestApi<GraphTimelineResponse>(`/api/graph/timeline?graphId=${graphData.graphId}`, {
      method: 'GET',
    })
      .then((data) => {
        if (isCancelled) return

        const items = (data.items || [])
          .map((item) => ({
            id: String(item.relationId),
            date: item.date,
            text: item.text,
          }))
          .sort((left, right) => left.date.localeCompare(right.date))

        setTimelineEntries(items)
      })
      .catch((timelineRequestError) => {
        if (isCancelled) return
        setTimelineEntries([])
        setTimelineError(
          timelineRequestError instanceof Error
            ? timelineRequestError.message
            : 'Failed to load timeline'
        )
      })
      .finally(() => {
        if (isCancelled) return
        setTimelineLoading(false)
      })

    return () => {
      isCancelled = true
    }
  }, [graphData?.graphId])

  if (view === 'result' && graphData) {
    return (
      <div className="result-view-container">
        <div className="result-top-nav">
          <div className="history-canvas-nav">
            {historyCanvases.map((canvas) => (
              <div className="history-canvas-item" key={canvas.id}>
                <div className="canvas-item-head">
                  <img src="/Vector.png" className="canvas-star-icon" alt="star" />
                  <span className="canvas-name">{canvas.name}</span>
                  <span className="canvas-date">{canvas.date}</span>
                </div>
                <div className="canvas-actions">
                  <button type="button" className="canvas-action-btn">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                    Edit
                  </button>
                  <button type="button" className="canvas-action-btn">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    Copy
                  </button>
                  <button type="button" className="canvas-action-btn canvas-action-btn-icon-only" aria-label="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2-2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                  </button>
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
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M19 12H5M5 12L12 19M5 12L12 5" stroke="#168cff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="result-nav-brand">
            <span style={{ color: '#0ea5e9', fontWeight: 800 }}>Evidence</span>
            <span style={{ color: '#3b82f6', marginLeft: '4px', fontWeight: 800 }}>Link</span>
          </div>
        </div>
        <div className="result-main">
          <div className="chart-panel" ref={chartPanelRef}>
            <div className="chart-content" style={{ padding: 0, overflow: 'hidden', position: 'relative' }}>
              <div className="chart-overlay-left">
                <button className="chart-export-btn">Export</button>
                <div className="chart-legend">
                  {dynamicCategories.map((type, idx) => (
                    <div className="legend-item" key={type}>
                      <span className="legend-dot" style={{ backgroundColor: ECHARTS_PALETTE[idx % ECHARTS_PALETTE.length] }}></span>
                      {type}
                    </div>
                  ))}
                </div>
              </div>
              <ReactECharts option={chartOptions} onEvents={chartEvents} style={{ height: '100%', width: '100%' }} />
              {isEvidenceBadgeVisible && selectedTargetLabel && (
                <div className="evidence-badge">
                  <div className="evidence-badge-header">
                    <div className="evidence-badge-title">Evidence badge</div>
                    <button
                      type="button"
                      className="evidence-badge-close"
                      aria-label="Close evidence badge"
                      onClick={() => setIsEvidenceBadgeVisible(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="evidence-badge-body">
                    <div className="evidence-badge-copy">
                      {summaryLoading
                        ? 'Loading evidence summary...'
                        : summaryText || 'No evidence summary available.'}
                    </div>
                    <div className="evidence-badge-list">
                      {renderEvidenceBadgeRows()}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div
              className="conflict-resizer"
              role="separator"
              aria-label="Resize conflict panel"
              aria-orientation="horizontal"
              onPointerDown={handleConflictResizeStart}
            >
              <span className="conflict-resizer-grip" />
            </div>
            <div className="conflict-panel" style={{ height: `${conflictPanelHeight}px` }}>
              <div className="conflict-title">Conflict Detected</div>
              {graphData.conflicts.length === 0 && <div className="conflict-empty">There are no conflicts detected.</div>}
              {graphData.conflicts.length > 0 && (
                <div className="conflict-card-row">
                  {graphData.conflicts.map((conflict) => (
                    (() => {
                      const preview = conflictPreviewMap[conflict.id]
                      const sourcesForCard = preview?.sources.slice(0, 2) ?? []
                      const isPreviewLoading = preview === undefined || preview.loading

                      return (
                        <div
                          key={conflict.id}
                          className="conflict-card"
                          onClick={() => void handleConflictAction(conflict)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              void handleConflictAction(conflict)
                            }
                          }}
                        >
                          <div className="conflict-card-header">
                            <div className="conflict-card-icon" aria-hidden="true">
                              <svg width="34" height="30" viewBox="0 0 64 56" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M28.536 4C30.0756 1.33333 33.9244 1.33334 35.4641 4L61.4449 49C62.9845 51.6667 61.0601 55 57.9808 55H6.01924C2.93995 55 1.01555 51.6667 2.5552 49L28.536 4Z" fill="#Facc15" />
                                <path d="M32 18V31" stroke="white" strokeWidth="5" strokeLinecap="round" />
                                <circle cx="32" cy="40" r="3.5" fill="white" />
                              </svg>
                            </div>
                            <div className="conflict-card-meta">
                              <div className="conflict-card-title">{conflict.description}</div>
                              <div className="conflict-card-subtitle">
                                {isPreviewLoading ? 'Loading sources...' : getConflictSubtitle(conflict, preview.sources)}
                              </div>
                            </div>
                          </div>
                          <div className="conflict-card-body">
                            {isPreviewLoading && <p>Loading conflict sources...</p>}
                            {!isPreviewLoading && preview.error && <p>{preview.error}</p>}
                            {!isPreviewLoading && !preview.error && sourcesForCard.length === 0 && (
                              <p>No source snippets available.</p>
                            )}
                            {!isPreviewLoading && !preview.error && sourcesForCard.map((source, index) => (
                              <p key={`${conflict.id}-${source.fileId}-${index}`}>
                                {String.fromCharCode(65 + index)}: {source.snippet}
                              </p>
                            ))}
                          </div>
                          <div className="conflict-card-actions" onClick={(event) => event.stopPropagation()}>
                            <button type="button" className="conflict-action-button" onClick={() => void handleConflictAction(conflict, 0)}>
                              Use A
                            </button>
                            <button type="button" className="conflict-action-button" onClick={() => void handleConflictAction(conflict, 1)}>
                              Use B
                            </button>
                            <button type="button" className="conflict-action-button" onClick={() => void handleConflictAction(conflict)}>
                              Edit
                            </button>
                          </div>
                        </div>
                      )
                    })()
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="doc-panel" ref={sidePanelRef}>
            <section className="side-card document-card" style={{ height: `${documentCardHeight}px` }}>
              <div className="side-card-header">
                <div className="file-selector-group">
                  <div className="file-selector-label">Files</div>
                  <div className="file-selector-chip">
                    <span className="file-selector-icon" aria-hidden="true">
                      ⇄
                    </span>
                    <span className="file-selector-text">
                      {highlightDoc?.fileName || uploadedFiles[0]?.fileName || 'Select file'}
                    </span>
                    <span className="file-selector-caret" aria-hidden="true">
                      ▾
                    </span>
                  </div>
                </div>
                <div className="doc-panel-caption">{uploadedFiles.length} files</div>
              </div>
              <div className="doc-content-wrapper compact-doc-content">
                <div className="doc-paper compact-doc-paper">
                  <h2 className="doc-title">{highlightDoc?.fileName || 'Document Preview'}</h2>
                  <div className="doc-meta">
                    {highlightLoading && <span>Loading text...</span>}
                    {!highlightLoading && highlightDoc?.content && <span>Preview only</span>}
                  </div>
                  <div className="doc-body">
                    <p>{renderHighlightedContent()}</p>
                  </div>
                </div>
              </div>
            </section>

            <div
              className="side-panel-resizer"
              role="separator"
              aria-label="Resize file and timeline panels"
              aria-orientation="horizontal"
              onPointerDown={(event) => handleSidePanelResizeStart('document', event)}
            >
              <span className="side-panel-resizer-grip" />
            </div>

            <section className="side-card timeline-card" style={{ height: `${timelineCardHeight}px` }}>
              <div className="side-card-header secondary-card-header">
                <div className="side-card-title">Timeline</div>
              </div>
              <div className="timeline-list">
                {timelineLoading && <div className="timeline-empty">Loading timeline...</div>}
                {!timelineLoading && timelineError && <div className="timeline-empty">{timelineError}</div>}
                {!timelineLoading && !timelineError && timelineEntries.length === 0 && (
                  <div className="timeline-empty">No timeline records.</div>
                )}
                {timelineEntries.map((entry, index) => (
                  <div key={entry.id} className={`timeline-item ${index === timelineEntries.length - 1 ? 'last' : ''}`}>
                    <div className="timeline-rail" aria-hidden="true">
                      <span className="timeline-dot" />
                      {index !== timelineEntries.length - 1 && <span className="timeline-line" />}
                    </div>
                    <div className="timeline-content">
                      <div className="timeline-date">{entry.date}</div>
                      <div className="timeline-description">{entry.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <div
              className="side-panel-resizer"
              role="separator"
              aria-label="Resize timeline and copilot panels"
              aria-orientation="horizontal"
              onPointerDown={(event) => handleSidePanelResizeStart('timeline', event)}
            >
              <span className="side-panel-resizer-grip" />
            </div>

            <section className="side-card copilot-card">
              <div className="side-card-header secondary-card-header">
                <div className="side-card-title">Copilot</div>
              </div>
              <div className="copilot-thread">
                {copilotMessages.map((message) => (
                  <div key={message.id} className={`copilot-message ${message.role === 'user' ? 'user' : 'assistant'}`}>
                    <div className="copilot-avatar">{message.role === 'user' ? 'You' : 'AI'}</div>
                    <div className="copilot-bubble-wrap">
                      <div className="copilot-bubble">
                        {message.role === 'assistant' ? (
                          <div className="copilot-markdown">
                            <MarkdownMessage content={message.content} />
                          </div>
                        ) : (
                          message.content
                        )}
                      </div>
                      <div className="copilot-timestamp">{message.timestamp}</div>
                    </div>
                  </div>
                ))}
              </div>
              <form className="copilot-input-row" onSubmit={handleCopilotSubmit}>
                <input
                  className="copilot-input"
                  value={copilotInput}
                  onChange={(event) => setCopilotInput(event.target.value)}
                  disabled={isCopilotSubmitting}
                  placeholder="Ask about the evidence graph..."
                />
                <button type="submit" className="copilot-send-btn" disabled={isCopilotSubmitting || !copilotInput.trim()}>
                  {isCopilotSubmitting ? 'Sending...' : 'Send'}
                </button>
              </form>
            </section>
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

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {content}
    </ReactMarkdown>
  )
}

export default App
