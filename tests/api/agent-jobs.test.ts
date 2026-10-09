import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), presignGet: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/env', () => ({ serverEnv: { agentSecret: 'a'.repeat(64) } }))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: mocks.from, rpc: mocks.rpc }) }))
vi.mock('@/lib/console/images', () => ({ consoleObjectStore: () => ({ presignGet: mocks.presignGet }) }))

import { GET, POST } from '@/app/api/agent/jobs/route'
import { POST as POST_ONE } from '@/app/api/agent/jobs/[jobId]/route'
import { JobInputError, defaultJobLabel, parseJobLabel, parseRunner, queueIsStale } from '@/lib/agent-jobs/label'

const TOKEN = 'a'.repeat(64)
const JOB_ID = '11111111-2222-4333-8444-555555555555'

function post(url: string, body: unknown, token: string | null = TOKEN): Request {
  return new Request(`http://localhost:3000${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}
const one = (body: unknown, token: string | null = TOKEN) => POST_ONE(post(`/api/agent/jobs/${JOB_ID}`, body, token), { params: Promise.resolve({ jobId: JOB_ID }) })

describe('label helpers', () => {
  it('builds the default label from local time and validates labels, runners and staleness', () => {
    expect(defaultJobLabel(new Date(2026, 9, 10, 14, 5))).toBe('2026-10-10 14.05')
    expect(parseJobLabel('  2026-10-10 14.05 ')).toBe('2026-10-10 14.05')
    expect(() => parseJobLabel('ab')).toThrow(JobInputError)
    expect(() => parseJobLabel('a/b/c')).toThrow(/slashes/)
    expect(parseRunner('canada-1')).toBe('canada-1')
    expect(() => parseRunner('bad runner!')).toThrow(JobInputError)
    const now = new Date('2026-10-10T10:00:00Z')
    expect(queueIsStale('2026-10-10T09:00:00Z', now)).toBe(true)
    expect(queueIsStale('2026-10-10T09:45:00Z', now)).toBe(false)
    expect(queueIsStale(null, now)).toBe(false)
  })
})

describe('/api/agent/jobs', () => {
  beforeEach(() => { mocks.from.mockReset(); mocks.rpc.mockReset(); mocks.presignGet.mockReset() })

  it('refuses without the bearer', async () => {
    expect((await POST(post('/api/agent/jobs', { action: 'claim', runner: 'canada-1' }, null))).status).toBe(401)
    expect((await GET(new Request('http://localhost:3000/api/agent/jobs?status=queued'))).status).toBe(401)
    expect((await one({ action: 'heartbeat', runner: 'canada-1' }, 'b'.repeat(64))).status).toBe(401)
  })

  it('claims nothing when the queue is empty', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    const response = await POST(post('/api/agent/jobs', { action: 'claim', runner: 'canada-1', lease_seconds: 1800 }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, job: null })
    expect(mocks.rpc).toHaveBeenCalledWith('agent_job_claim', { p_runner: 'canada-1', p_lease_seconds: 1800 })
  })

  it('claims a job and signs every uploaded photo', async () => {
    mocks.rpc.mockResolvedValue({ data: { id: JOB_ID, label: '2026-10-10 14.05', photo_count: 2 }, error: null })
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({
      data: [{ id: 'p1', filename: 'a.jpg', storage_key: `intake/${JOB_ID}/p1.jpg` }, { id: 'p2', filename: 'b.jpg', storage_key: `intake/${JOB_ID}/p2.jpg` }], error: null,
    }) }) }) }) })
    mocks.presignGet.mockImplementation(async (key: string) => `https://r2.example/${key}?sig`)
    const response = await POST(post('/api/agent/jobs', { action: 'claim', runner: 'canada-1' }))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.job.label).toBe('2026-10-10 14.05')
    expect(body.job.photos).toEqual([
      { id: 'p1', filename: 'a.jpg', url: `https://r2.example/intake/${JOB_ID}/p1.jpg?sig` },
      { id: 'p2', filename: 'b.jpg', url: `https://r2.example/intake/${JOB_ID}/p2.jpg?sig` },
    ])
    expect(mocks.presignGet).toHaveBeenCalledWith(`intake/${JOB_ID}/p1.jpg`, 1200)
  })

  it('rejects a bad runner, a bad action and a bad lease', async () => {
    expect((await POST(post('/api/agent/jobs', { action: 'claim', runner: 'no spaces' }))).status).toBe(400)
    expect((await POST(post('/api/agent/jobs', { action: 'release', runner: 'canada-1' }))).status).toBe(400)
    expect((await POST(post('/api/agent/jobs', { action: 'claim', runner: 'canada-1', lease_seconds: 5 }))).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('lists by status with a capped limit', async () => {
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ order: () => ({ limit: async (n: number) => ({ data: [{ id: JOB_ID, label: 'x', status: 'done', created_at: 't', queued_at: null, started_at: null, finished_at: null, runner: null, note: null, error: null, photo_count: 1, result_count: 1 }], error: null, n }) }) }) }) })
    const response = await GET(new Request('http://localhost:3000/api/agent/jobs?status=done&limit=500', { headers: { authorization: `Bearer ${TOKEN}` } }))
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.jobs[0]).toMatchObject({ id: JOB_ID, status: 'done', photoCount: 1, resultCount: 1 })
    expect((await GET(new Request('http://localhost:3000/api/agent/jobs?status=sleeping', { headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(400)
  })

  it('finishes done and failed through the RPC and validates the rest', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    expect((await one({ action: 'done', runner: 'canada-1', note: 'all matched', result_count: 7 })).status).toBe(200)
    expect(mocks.rpc).toHaveBeenLastCalledWith('agent_job_finish', { p_job_id: JOB_ID, p_runner: 'canada-1', p_status: 'done', p_note: 'all matched', p_error: null, p_result_count: 7 })
    expect((await one({ action: 'failed', runner: 'canada-1', error: 'codex out of credits' })).status).toBe(200)
    expect(mocks.rpc).toHaveBeenLastCalledWith('agent_job_finish', expect.objectContaining({ p_status: 'failed', p_error: 'codex out of credits', p_result_count: 0 }))
    expect((await one({ action: 'heartbeat', runner: 'canada-1', lease_seconds: 600 })).status).toBe(200)
    expect(mocks.rpc).toHaveBeenLastCalledWith('agent_job_heartbeat', { p_job_id: JOB_ID, p_runner: 'canada-1', p_lease_seconds: 600 })
    expect((await one({ action: 'done', runner: 'canada-1', result_count: -1 })).status).toBe(400)
    expect((await one({ action: 'pause', runner: 'canada-1' })).status).toBe(400)
    expect((await POST_ONE(post('/api/agent/jobs/nope', { action: 'done', runner: 'canada-1' }), { params: Promise.resolve({ jobId: 'nope' }) })).status).toBe(400)
  })

  it('turns a refused RPC into a 400 with the hint', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'agent_job_finish: job is not running under canada-1', hint: null } })
    const response = await one({ action: 'done', runner: 'canada-1' })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/not running/)
  })
})
