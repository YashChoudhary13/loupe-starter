import { describe, expect, it, vi } from 'vitest'

import { EnhancementError } from '@/lib/enhance/errors'
import { OpenRouterClient } from '@/lib/enhance/openrouter'

import { TEST_DESCRIPTION } from './helpers/enhancement'

describe('OpenRouter two-call client', () => {
  it('sends only the describe prompt + image with minimal reasoning and records actual cost', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return Response.json({
        id: 'describe-request-1',
        model: 'openai/gpt-5.6-sol',
        choices: [{
          message: {
            content: JSON.stringify({
              description: TEST_DESCRIPTION,
              presentation: 'pair-upright',
            }),
          },
        }],
        usage: { cost: 0.004321 },
      })
    })
    const client = new OpenRouterClient('test-key', fetchMock as typeof fetch)

    await expect(
      client.describe(Buffer.from('source'), 'image/jpeg', 'PROMPT FROM DATABASE', {
        model: 'openai/gpt-5.6-sol',
        reasoningEffort: 'minimal',
      }),
    ).resolves.toEqual({
      text: TEST_DESCRIPTION,
      presentation: 'pair-upright',
      costUsd: 0.004321,
      model: 'openai/gpt-5.6-sol',
      requestId: 'describe-request-1',
    })

    expect(requests[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(requests[0]?.body).toMatchObject({
      model: 'openai/gpt-5.6-sol',
      reasoning: { effort: 'minimal', exclude: true },
      max_completion_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'PROMPT FROM DATABASE' },
            {
              type: 'image_url',
              image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,/) },
            },
          ],
        },
      ],
    })
    expect(JSON.stringify(requests[0]?.body)).not.toContain('filename')
    expect(JSON.stringify(requests[0]?.body)).not.toContain('category')
  })

  it('sets image size and quality explicitly and parses usage.cost', async () => {
    const requests: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({
        id: 'image-request-1',
        model: 'openai/gpt-image-2-resolved',
        data: [{ b64_json: Buffer.from('generated-image').toString('base64') }],
        usage: { cost: '0.083125' },
      })
    })
    const client = new OpenRouterClient('test-key', fetchMock as typeof fetch)

    await expect(
      client.enhance(Buffer.from('source'), 'image/png', 'RESOLVED PROMPT', {
        model: 'openai/gpt-image-2',
        size: '1280x1280',
        quality: 'medium',
      }),
    ).resolves.toEqual({
      image: Buffer.from('generated-image'),
      costUsd: 0.083125,
      model: 'openai/gpt-image-2-resolved',
      generationId: 'image-request-1',
    })
    expect(requests[0]).toMatchObject({
      model: 'openai/gpt-image-2',
      prompt: 'RESOLVED PROMPT',
      size: '1280x1280',
      quality: 'medium',
      n: 1,
      input_references: [
        {
          type: 'image_url',
          image_url: {
            url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        },
      ],
    })
  })

  it('uses the shared 1:1 edit contract for a curated non-OpenAI image model', async () => {
    const requests: Record<string, unknown>[] = []
    const client = new OpenRouterClient(
      'test-key',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({
          id: 'flux-request',
          model: 'black-forest-labs/flux.2-pro',
          data: [{ b64_json: Buffer.from('generated-image').toString('base64') }],
          usage: { cost: 0.03 },
        })
      }) as typeof fetch,
    )

    await client.enhance(Buffer.from('source'), 'image/jpeg', 'PROMPT', {
      model: 'black-forest-labs/flux.2-pro',
      size: '1280x1280',
      quality: 'medium',
    })

    expect(requests[0]).toMatchObject({
      model: 'black-forest-labs/flux.2-pro',
      aspect_ratio: '1:1',
      n: 1,
    })
    expect(requests[0]).not.toHaveProperty('size')
    expect(requests[0]).not.toHaveProperty('quality')
  })

  it.each(['google/gemini-3.5-flash-lite', 'anthropic/claude-haiku-4.5', 'qwen/qwen3.7-flash'])(
    'sends minimal-effort reasoning controls to the curated descriptor provider %s',
    async (model) => {
      const requests: Record<string, unknown>[] = []
      const client = new OpenRouterClient(
        'test-key',
        vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return Response.json({
            model,
            choices: [{
              message: {
                content: JSON.stringify({
                  description: TEST_DESCRIPTION,
                  presentation: 'pair-upright',
                }),
              },
            }],
            usage: { cost: 0.001 },
          })
        }) as typeof fetch,
      )

      await client.describe(Buffer.from('source'), 'image/jpeg', 'PROMPT', {
        model,
        reasoningEffort: 'minimal',
      })

      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.reasoning).toEqual({ effort: 'minimal', exclude: true })
    },
  )

  it('accepts a structured description wrapped in a Markdown JSON fence', async () => {
    const client = new OpenRouterClient(
      'test-key',
      vi.fn(async () =>
        Response.json({
          id: 'fenced-structured-request',
          model: 'openai/gpt-5.6-sol',
          choices: [{
            message: {
              content: `\`\`\`json\n${JSON.stringify({
                description: TEST_DESCRIPTION,
                presentation: 'angled-band',
              })}\n\`\`\``,
            },
          }],
          usage: { cost: 0.004 },
        }),
      ) as typeof fetch,
    )

    await expect(
      client.describe(Buffer.from('source'), 'image/jpeg', 'structured prompt', {
        model: 'openai/gpt-5.6-sol',
        reasoningEffort: 'minimal',
      }),
    ).resolves.toMatchObject({
      text: TEST_DESCRIPTION,
      presentation: 'angled-band',
      model: 'openai/gpt-5.6-sol',
      requestId: 'fenced-structured-request',
    })
  })

  it('omits reasoning controls for a provider family OpenRouter does not document as reasoning-capable', async () => {
    const requests: Record<string, unknown>[] = []
    const client = new OpenRouterClient(
      'test-key',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({
          model: 'mistralai/pixtral-large-2.1',
          choices: [{
            message: {
              content: JSON.stringify({
                description: TEST_DESCRIPTION,
                presentation: 'pair-upright',
              }),
            },
          }],
          usage: { cost: 0.001 },
        })
      }) as typeof fetch,
    )

    await client.describe(Buffer.from('source'), 'image/jpeg', 'PROMPT', {
      model: 'mistralai/pixtral-large-2.1',
      reasoningEffort: 'minimal',
    })

    expect(requests[0]?.model).toBe('mistralai/pixtral-large-2.1')
    expect(requests[0]).not.toHaveProperty('reasoning')
  })

  it.each([
    {
      label: 'malformed JSON',
      raw: '{"description":',
      code: 'description_invalid_json',
      reason: 'invalid_json',
    },
    {
      label: 'an invented presentation class',
      raw: JSON.stringify({
        description: TEST_DESCRIPTION,
        presentation: 'ring',
      }),
      code: 'description_presentation_invalid',
      reason: 'presentation_invalid',
    },
  ])(
    'retains the invalid raw result and precise reason for $label',
    async ({ raw, code, reason }) => {
      const client = new OpenRouterClient(
        'test-key',
        vi.fn(async () =>
          Response.json({
            id: 'invalid-structured-request',
            choices: [{ message: { content: raw } }],
            usage: { cost: 0.004 },
          }),
        ) as typeof fetch,
      )

      await expect(
        client.describe(
          Buffer.from('source'),
          'image/jpeg',
          'structured prompt',
          {
            model: 'openai/gpt-5.6-sol',
            reasoningEffort: 'minimal',
          },
        ),
      ).rejects.toMatchObject({
        stage: 'describe',
        code,
        retryable: true,
        detail: {
          parse_reason: reason,
          raw_result: raw,
        },
      } satisfies Partial<EnhancementError>)
    },
  )

  /**
   * Measured live on 2026-08-05: OpenRouter answers 402 when the balance is
   * below the reserve it holds before starting a gpt-image-2 request, not only
   * when it is zero. Classified as permanent this marked every queued
   * photograph `failed` and told the operator the photograph was rejected.
   */
  it('classifies an OpenRouter 402 as a retryable account quota condition, not a rejected photograph', async () => {
    const body = {
      error: {
        message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
        code: 402,
        metadata: { limit_source: 'openrouter_credits' },
      },
    }
    const client = new OpenRouterClient(
      'test-key',
      vi.fn(async () => Response.json(body, { status: 402 })) as typeof fetch,
    )

    const image = client.enhance(Buffer.from('source'), 'image/jpeg', 'prompt', {
      model: 'openai/gpt-image-2',
      size: '1280x1280',
      quality: 'medium',
    })
    await expect(image).rejects.toMatchObject({
      stage: 'image',
      code: 'image_provider_quota_exhausted',
      retryable: true,
      quota: true,
    } satisfies Partial<EnhancementError>)
    // The message must point at billing, never at the photograph.
    await expect(image).rejects.toThrow(/insufficient credit/i)

    const description = client.describe(Buffer.from('source'), 'image/jpeg', 'prompt', {
      model: 'openai/gpt-5.6-sol',
      reasoningEffort: 'minimal',
    })
    await expect(description).rejects.toMatchObject({
      code: 'describe_provider_quota_exhausted',
      quota: true,
    } satisfies Partial<EnhancementError>)
  })

  it('keeps a describe provider failure retryable but a policy image failure permanent', async () => {
    const describeClient = new OpenRouterClient(
      'test-key',
      vi.fn(async () =>
        Response.json(
          { error_type: 'provider_error', error: { message: 'raw' } },
          { status: 400 },
        ),
      ) as typeof fetch,
    )
    const describe = describeClient.describe(
      Buffer.from('source'),
      'image/jpeg',
      'prompt',
      { model: 'openai/gpt-5.6-sol', reasoningEffort: 'minimal' },
    )
    await expect(describe).rejects.toMatchObject({
      stage: 'describe',
      retryable: true,
    } satisfies Partial<EnhancementError>)

    const imageClient = new OpenRouterClient(
      'test-key',
      vi.fn(async () =>
        Response.json(
          { error_type: 'content_policy_violation', error: { message: 'raw' } },
          { status: 400 },
        ),
      ) as typeof fetch,
    )
    const image = imageClient.enhance(Buffer.from('source'), 'image/jpeg', 'prompt', {
      model: 'openai/gpt-image-2',
      size: '1280x1280',
      quality: 'medium',
    })
    await expect(image).rejects.toMatchObject({
      code: 'image_content_policy',
      retryable: false,
    } satisfies Partial<EnhancementError>)
  })
})
