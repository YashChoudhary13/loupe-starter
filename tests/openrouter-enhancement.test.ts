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
        choices: [{ message: { content: TEST_DESCRIPTION } }],
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
      costUsd: 0.004321,
      model: 'openai/gpt-5.6-sol',
      requestId: 'describe-request-1',
    })

    expect(requests[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(requests[0]?.body).toMatchObject({
      model: 'openai/gpt-5.6-sol',
      reasoning: { effort: 'minimal', exclude: true },
      max_completion_tokens: 400,
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
