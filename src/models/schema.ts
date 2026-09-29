/**
 * JSON Schema adaptation for providers that accept only a subset.
 *
 * Flex tools describe their input with zod, which emits full JSON Schema
 * (draft 2020-12). OpenAI-compatible servers take that as-is, minus `$schema`.
 * Gemini takes an OpenAPI 3.0 *subset* and rejects unknown keywords with a 400,
 * so the schema is translated rather than forwarded.
 */

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Remove keywords that only describe the schema document itself. */
export function cleanJsonSchema(schema: Json): Json {
  const { $schema: _dropped, ...rest } = schema
  return rest
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const GEMINI_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])
/** `format` values Gemini accepts; anything else is a 400. */
const GEMINI_FORMATS = new Set(['enum', 'date-time', 'int32', 'int64', 'float', 'double'])

export function toGeminiSchema(schema: Json): Json | undefined {
  const defs = isObject(schema.$defs)
    ? schema.$defs
    : isObject(schema.definitions)
      ? schema.definitions
      : {}
  const converted = convert(schema, defs as Record<string, Json>, new Set())
  // An object with no properties is rejected outright; "takes no arguments" is
  // expressed by omitting `parameters`.
  if (!converted || (converted.type === 'OBJECT' && !isObject(converted.properties)))
    return undefined
  if (converted.type === 'OBJECT' && Object.keys(converted.properties as Json).length === 0) {
    return undefined
  }
  return converted
}

function convert(node: unknown, defs: Record<string, Json>, seen: Set<string>): Json | undefined {
  if (!isObject(node)) return undefined

  // Resolve local $refs by inlining. A cycle cannot be expressed, so it degrades
  // to an unconstrained object rather than recursing forever.
  if (typeof node.$ref === 'string') {
    const name = node.$ref.replace(/^#\/(\$defs|definitions)\//, '')
    if (seen.has(name)) return { type: 'OBJECT', description: 'recursive structure' }
    const target = defs[name]
    if (!target) return {}
    return convert({ ...target, ...withoutRef(node) }, defs, new Set([...seen, name]))
  }

  const out: Json = {}

  // `const` and single-value enums become an enum.
  if ('const' in node) out.enum = [String(node.const)]
  if (Array.isArray(node.enum)) out.enum = node.enum.map((v) => String(v))

  // Type: `["string","null"]` is JSON Schema's nullable; Gemini has a flag.
  let type = node.type
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null')
    if (nonNull.length !== type.length) out.nullable = true
    type = nonNull[0]
  }
  if (typeof type === 'string' && GEMINI_TYPES.has(type)) out.type = type.toUpperCase()

  // anyOf/oneOf: nullable unions collapse; real unions map to anyOf.
  const union = (
    Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null
  ) as unknown[] | null
  if (union) {
    const members = union.filter((m) => !(isObject(m) && m.type === 'null'))
    if (members.length !== union.length) out.nullable = true
    if (members.length === 1) {
      Object.assign(out, convert(members[0], defs, seen) ?? {})
    } else {
      const converted = members.map((m) => convert(m, defs, seen)).filter((m): m is Json => !!m)
      if (converted.length > 0) out.anyOf = converted
    }
  }

  if (typeof node.description === 'string') out.description = node.description
  if (typeof node.title === 'string' && !out.description) out.description = node.title
  if (typeof node.format === 'string' && GEMINI_FORMATS.has(node.format)) out.format = node.format
  for (const key of ['minimum', 'maximum', 'minItems', 'maxItems'] as const) {
    if (typeof node[key] === 'number') out[key] = node[key]
  }

  if (isObject(node.properties)) {
    const properties: Json = {}
    for (const [key, value] of Object.entries(node.properties)) {
      const child = convert(value, defs, seen)
      if (child) properties[key] = child
    }
    out.properties = properties
    if (!out.type) out.type = 'OBJECT'
    if (Array.isArray(node.required)) {
      const required = node.required.filter(
        (k): k is string => typeof k === 'string' && k in properties,
      )
      if (required.length > 0) out.required = required
    }
  }

  if (node.items !== undefined) {
    const items = convert(Array.isArray(node.items) ? node.items[0] : node.items, defs, seen)
    out.items = items ?? {}
    if (!out.type) out.type = 'ARRAY'
  }
  if (out.type === 'ARRAY' && !out.items) out.items = { type: 'STRING' }

  // Gemini only allows `enum` on strings.
  if (out.enum) out.type = 'STRING'
  // An untyped leaf still needs a type or Gemini rejects the declaration.
  if (!out.type && !out.anyOf) out.type = 'STRING'
  return out
}

function withoutRef(node: Json): Json {
  const { $ref: _ref, ...rest } = node
  return rest
}
