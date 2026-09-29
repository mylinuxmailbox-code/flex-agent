import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { ProviderId } from '../models/registry.js'
import { theme } from './theme.js'

export interface SetupResult {
  providerId: ProviderId
  providerName?: string
  /** Custom endpoints may intentionally run without an API key. */
  isCustomEndpoint: boolean
  model: string
  baseURL?: string
  apiKey?: string
}

interface SetupOption {
  id: ProviderId
  label: string
  detail: string
  defaultModel: string
  defaultBaseURL?: string
  needsBaseURL: boolean
}

const OPTIONS: readonly SetupOption[] = [
  {
    id: 'google',
    label: 'Google AI Studio',
    detail: 'Gemini models and native reasoning support',
    defaultModel: 'gemini-2.5-flash',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
    needsBaseURL: false,
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI',
    detail: 'OpenAI models through the OpenAI API',
    defaultModel: 'gpt-4o',
    defaultBaseURL: 'https://api.openai.com/v1',
    needsBaseURL: false,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    detail: 'Claude models and native tool use',
    defaultModel: 'claude-opus-5-5',
    needsBaseURL: false,
  },
  {
    id: 'openai-compatible',
    label: 'DeepSeek',
    detail: 'DeepSeek through its OpenAI-compatible endpoint',
    defaultModel: 'deepseek-chat',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    needsBaseURL: false,
  },
  {
    id: 'openai-compatible',
    label: 'Mistral',
    detail: 'Mistral through its OpenAI-compatible endpoint',
    defaultModel: 'mistral-large-latest',
    defaultBaseURL: 'https://api.mistral.ai/v1',
    needsBaseURL: false,
  },
  {
    id: 'openai-compatible',
    label: 'Hosted Llama (choose endpoint)',
    detail: 'Use Groq, Together, Fireworks, or another compatible host',
    defaultModel: 'llama-3.3-70b-versatile',
    defaultBaseURL: 'https://api.groq.com/openai/v1',
    needsBaseURL: true,
  },
  {
    id: 'openai-compatible',
    label: 'Other / custom endpoint',
    detail: 'Ollama, vLLM, LM Studio, OpenRouter, or a company endpoint',
    defaultModel: 'llama3.1',
    needsBaseURL: true,
  },
]

type Field = 'name' | 'baseURL' | 'apiKey' | 'model'

export function FirstRunSetup({
  initialProvider,
  onComplete,
  onCancel,
}: {
  initialProvider?: ProviderId
  onComplete: (result: SetupResult) => void
  onCancel: () => void
}) {
  const initialIndex = initialProvider
    ? Math.max(
        0,
        OPTIONS.findIndex((option) => option.id === initialProvider),
      )
    : 0
  const [stage, setStage] = useState<'provider' | 'fields'>('provider')
  const [selected, setSelected] = useState(initialIndex)
  const [fieldIndex, setFieldIndex] = useState(0)
  const [values, setValues] = useState<Record<Field, string>>({
    name: '',
    baseURL: '',
    apiKey: '',
    model: '',
  })
  const [touched, setTouched] = useState<Record<Field, boolean>>({
    name: false,
    baseURL: false,
    apiKey: false,
    model: false,
  })

  const option = OPTIONS[selected] ?? OPTIONS[0]!
  const fields = fieldsFor(option)
  const field = fields[fieldIndex] ?? 'apiKey'
  const isSecret = field === 'apiKey'

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }

    if (stage === 'provider') {
      if (key.upArrow) {
        setSelected((index) => (index - 1 + OPTIONS.length) % OPTIONS.length)
      } else if (key.downArrow) {
        setSelected((index) => (index + 1) % OPTIONS.length)
      } else if (key.return) {
        const defaults: Record<Field, string> = {
          name: option.label === 'Other / custom endpoint' ? '' : option.label,
          baseURL: option.defaultBaseURL ?? '',
          apiKey: '',
          model: option.defaultModel,
        }
        setValues(defaults)
        setTouched({ name: false, baseURL: false, apiKey: false, model: false })
        setFieldIndex(0)
        setStage('fields')
      }
      return
    }

    if (key.leftArrow && fieldIndex > 0) {
      setFieldIndex((index) => index - 1)
      return
    }
    if (key.return) {
      if (fieldIndex < fields.length - 1) {
        setFieldIndex((index) => index + 1)
      } else {
        onComplete({
          providerId: option.id,
          providerName: values.name.trim() || undefined,
          isCustomEndpoint: option.label === 'Other / custom endpoint',
          model: values.model.trim() || option.defaultModel,
          baseURL: values.baseURL.trim() || undefined,
          apiKey: values.apiKey.trim() || undefined,
        })
      }
      return
    }
    if (key.backspace || key.delete) {
      setTouched((current) => ({ ...current, [field]: true }))
      setValues((current) => ({ ...current, [field]: current[field].slice(0, -1) }))
      return
    }
    if (!key.ctrl && !key.meta && input && !input.includes('\n')) {
      setTouched((current) => ({ ...current, [field]: true }))
      setValues((current) => ({
        ...current,
        [field]: touched[field] ? current[field] + input : input,
      }))
    }
  })

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.brand} bold>
        ╭──────────────────────────────────────────╮
      </Text>
      <Text color={theme.brand} bold>
        │ Welcome to Flex │
      </Text>
      <Text color={theme.brand} bold>
        │ Autonomous coding agent for CLI │
      </Text>
      <Text color={theme.brand} bold>
        ╰──────────────────────────────────────────╯
      </Text>
      <Text> </Text>
      {stage === 'provider' ? (
        <>
          <Text color={theme.text}>No AI provider has been configured yet.</Text>
          <Text color={theme.textDim}>Choose a provider. Enter selects; Esc exits.</Text>
          <Text> </Text>
          {OPTIONS.map((item, index) => (
            <Box key={`${item.label}-${index}`}>
              <Text color={index === selected ? theme.brand : theme.textFaint}>
                {index === selected ? '❯ ' : '  '}
              </Text>
              <Text
                color={index === selected ? theme.text : theme.textDim}
                bold={index === selected}
              >
                {item.label}
              </Text>
              <Text color={theme.textFaint}> — {item.detail}</Text>
            </Box>
          ))}
        </>
      ) : (
        <>
          <Text color={theme.brand} bold>
            Configure {option.label}
          </Text>
          <Text color={theme.textDim}>
            Enter accepts the shown value. Left moves back. Esc exits.
          </Text>
          <Text> </Text>
          {fields.map((item, index) => (
            <Box key={item}>
              <Text color={index === fieldIndex ? theme.brand : theme.textFaint}>
                {index === fieldIndex ? '❯ ' : '  '}
              </Text>
              <Text color={index === fieldIndex ? theme.text : theme.textDim}>
                {labelFor(item)}:{' '}
                {index === fieldIndex ? displayValue(values[item], isSecret) : '…'}
              </Text>
            </Box>
          ))}
          <Text> </Text>
          <Text color={theme.textFaint}>
            {field === 'apiKey'
              ? 'Keys are stored in ~/.flex/config/credentials.json with mode 0600; environment variables remain supported.'
              : 'You can change this later with /model or by choosing a provider-prefixed model.'}
          </Text>
        </>
      )}
    </Box>
  )
}

function fieldsFor(option: SetupOption): Field[] {
  if (option.label === 'Other / custom endpoint') {
    return ['name', 'baseURL', 'apiKey', 'model']
  }
  if (option.needsBaseURL) return ['baseURL', 'apiKey', 'model']
  return ['apiKey', 'model']
}

function labelFor(field: Field): string {
  switch (field) {
    case 'name':
      return 'Provider name'
    case 'baseURL':
      return 'Base URL'
    case 'apiKey':
      return 'API key'
    case 'model':
      return 'Model'
  }
}

function displayValue(value: string, secret: boolean): string {
  if (!value) return '▌'
  return secret ? `${'•'.repeat(Math.min(value.length, 24))}▌` : `${value}▌`
}

export { OPTIONS as setupProviderOptions }
