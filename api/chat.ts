import { GoogleGenAI } from '@google/genai'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() ?? ''

export default async function handler(req: {
  method?: string
  body?: unknown
}, res: {
  status: (code: number) => { json: (body: unknown) => void }
}) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!GEMINI_API_KEY) {
    res.status(500).json({ error: 'Missing GEMINI_API_KEY on the server' })
    return
  }

  const body = req.body
  const message = body && typeof body === 'object' && 'message' in body
    ? String((body as { message?: unknown }).message ?? '').trim()
    : ''

  if (!message) {
    res.status(400).json({ error: 'Message is required' })
    return
  }

  try {
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY })
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: message,
    })

    const text = response.text?.trim()
    if (!text) {
      res.status(502).json({ error: 'Gemini returned an empty response' })
      return
    }

    res.status(200).json({ message: text })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Gemini request failed',
    })
  }
}
