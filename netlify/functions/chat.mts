import Anthropic from "@anthropic-ai/sdk"
import type { Config, Context } from "@netlify/functions"

// Proxy del asistente del informe. La página ejecuta las herramientas sobre sus propios datos
// (descifrados en el navegador) y este endpoint solo conversa con el modelo vía Netlify AI Gateway.

// Verificador PBKDF2 de la clave (mismo costo que el cifrado de los datos de la página)
const CLAVE_SAL = "NqDwl87BR4qboKPAeDVkFA=="
const CLAVE_PBKDF2 = "476795a589a74d769cdd12918a731b4286d5bd1ba51613005a501f8301b10f0a"
const ORIGENES = ["https://matbravos.github.io", "https://revision-consumo-maicao.netlify.app"]
const MODELOS = ["claude-sonnet-5-5", "claude-sonnet-4-5", "claude-haiku-5-5"]

const SYSTEM = `Eres el asistente del informe "Revisión de consumo Maicao" (FEMSA Salud). Respondes en español de Chile, breve y directo, como un analista de category management.

Reglas:
- Usa SOLO datos que obtengas con las herramientas. Si no hay dato, dilo. Nunca inventes cifras.
- Compara 2026 contra los mismos meses de 2025 salvo que pidan otra cosa. Meses disponibles: enero a octubre (1 a 10). Noviembre solo existe en la proyección.
- Las transacciones no se suman entre mundos ni macrocategorías del mismo mes: usa lo que devuelve la herramienta para cada nivel.
- Precio promedio = venta/unidades; ticket = venta/transacciones; margen = contribución/venta; unidades por ticket = unidades/transacciones; penetración MMPP = venta MMPP/venta total.
- Market share F+P = venta Maicao / venta farmacias+perfumerías Nielsen; share total = Maicao / (F+P + supermercados).
- Montos en millones de pesos con formato chileno ($1.234 MM), variaciones con un decimal (−2,3%), share en puntos (pp) con dos decimales.
- Si la pregunta es ambigua, usa el filtro que el usuario tiene en pantalla (viene en el contexto) o el total Consumo.
- Usa los nombres de mundo y macrocategoría tal como los da la herramienta "catalogo" (en mayúsculas). Llámala si no sabes el nombre exacto.
- Respuestas de 2 a 6 líneas; usa viñetas cortas solo si comparas varias cosas. Puedes usar **negrita** para la cifra clave.`

const S = (props: Record<string, unknown>, req: string[] = []) => ({ type: "object", properties: props, required: req })
const meses = { type: "array", items: { type: "integer", minimum: 1, maximum: 10 }, description: "Meses 1 a 10 (2026 vs 2025). Si se omite: enero a octubre." }
const unidad = { type: "string", enum: ["CONSUMO", "FARMA"], description: "Unidad comercial. Por defecto CONSUMO." }
const mundo = { type: "string", description: "Mundo en mayúsculas, ej. HIGIENE. Vacío = total de la unidad." }
const macro = { type: "string", description: "Macrocategoría en mayúsculas, ej. DESODORANTES CORPORALES. Requiere mundo." }

const TOOLS = [
  { name: "catalogo", description: "Lista unidades, mundos y macrocategorías disponibles con sus nombres exactos.", input_schema: S({}) },
  { name: "indicadores", description: "Venta, unidades, transacciones, ticket, precio, margen, unidades por ticket y penetración MMPP de una selección, 2026 vs 2025. Con por_mes=true devuelve cada mes por separado.",
    input_schema: S({ unidad, mundo, macro, meses, marca: { type: "string", enum: ["TOTAL", "MMPP", "RESTO"] }, por_mes: { type: "boolean" } }) },
  { name: "apertura", description: "Abre una selección en sus hijos (unidad → mundos, mundo → macrocategorías) con venta, crecimiento, aporte, transacciones, precio, margen y Δ share F+P. Sirve para ver dónde se gana o pierde.",
    input_schema: S({ unidad, mundo, meses }) },
  { name: "market_share", description: "Market share Nielsen F+P y total de una selección (solo Consumo) en meses o en una semana Nielsen, con crecimiento de F+P, SM y Maicao. Con por_semana=true devuelve la serie semanal.",
    input_schema: S({ mundo, macro, meses, semana: { type: "integer", minimum: 1, maximum: 53 }, por_semana: { type: "boolean" } }) },
  { name: "marcas_share", description: "Marcas Nielsen que más ganan o pierden share en la selección, ordenadas por valor en pesos del cambio de share. Opcional: buscar una marca por nombre.",
    input_schema: S({ mundo, macro, meses, canal: { type: "string", enum: ["fp", "total"] }, top: { type: "integer", minimum: 1, maximum: 15 }, buscar: { type: "string" } }) },
  { name: "proyeccion_noviembre", description: "Proyección de venta de noviembre 2026 de Consumo con mayorista (real al 9-nov, resto proyectado sobre día homólogo), por segmento Retail POS, Retail Web y Mayorista, con apertura por mundo o macrocategoría.",
    input_schema: S({ mundo, macro }) },
  { name: "efecto_farma", description: "Efecto de la unidad Farma en la cadena para los meses elegidos: variación de farma, su peso y cómo crece la cadena con y sin farma.",
    input_schema: S({ meses }) },
  { name: "venta_diaria", description: "Venta diaria por unidad comercial entre dos fechas (YYYY-MM-DD, desde ene-2025 hasta el último día cargado), con el día homólogo del año anterior (364 días antes).",
    input_schema: S({ unidad, desde: { type: "string" }, hasta: { type: "string" } }, ["desde", "hasta"]) }
]

const verificadas = new Set<string>()
const claveOk = async (clave: string) => {
  if (verificadas.has(clave)) return true
  const sal = Uint8Array.from(atob(CLAVE_SAL), (c) => c.charCodeAt(0))
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave), "PBKDF2", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: sal, iterations: 250000, hash: "SHA-256" }, base, 256)
  const hex = [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, "0")).join("")
  if (hex === CLAVE_PBKDF2) { verificadas.add(clave); return true }
  return false
}

export default async (req: Request, context: Context) => {
  const origin = req.headers.get("origin") || ""
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": ORIGENES.includes(origin) ? origin : ORIGENES[1],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin"
  }
  const out = (body: unknown, status = 200) => Response.json(body, { status, headers: cors })
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
  if (req.method !== "POST") return out({ error: "Método no permitido" }, 405)
  if (origin && !ORIGENES.includes(origin)) return out({ error: "Origen no permitido" }, 403)

  const raw = await req.text()
  if (raw.length > 400_000) return out({ error: "Conversación demasiado larga. Empieza una nueva." }, 413)
  let body: { clave?: string; messages?: unknown[]; contexto?: string }
  try { body = JSON.parse(raw) } catch { return out({ error: "JSON inválido" }, 400) }
  if (!body.clave || !(await claveOk(String(body.clave)))) return out({ error: "Clave incorrecta" }, 401)
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (!messages.length || messages.length > 80) return out({ error: "Conversación inválida o demasiado larga. Empieza una nueva." }, 400)

  if (!Netlify.env.get("ANTHROPIC_BASE_URL") && !Netlify.env.get("ANTHROPIC_API_KEY"))
    return out({ error: "La IA no está activa en este sitio (AI Gateway de Netlify)." }, 503)

  const client = new Anthropic()
  const system = SYSTEM + "\n\nContexto de la vista del usuario: " + String(body.contexto || "sin filtros").slice(0, 1500)
  let last: unknown = null
  for (const model of MODELOS) {
    try {
      const r = await client.messages.create({ model, max_tokens: 1500, system, tools: TOOLS as never, messages: messages as never })
      return out({ content: r.content, stop_reason: r.stop_reason, model: r.model })
    } catch (e: any) {
      last = e
      const msg = String(e?.message || "")
      if (e?.status === 404 || (e?.status === 400 && /model/i.test(msg))) continue
      return out({ error: "Error de la IA: " + msg.slice(0, 300) }, 502)
    }
  }
  return out({ error: "Ningún modelo disponible: " + String((last as any)?.message || "").slice(0, 300) }, 502)
}

export const config: Config = {
  path: "/api/chat",
  method: ["POST", "OPTIONS"],
  rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ["ip", "domain"] }
}
