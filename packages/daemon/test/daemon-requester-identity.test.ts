// BC fork: the trusted live requester a `requesterIdentity` MCP child reads over the real control
// socket, with the token and endpoint the daemon itself injected into that child's session.
// A turn that folds in a message from anyone else must not name its first sender.
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { decodeFrames, encodeFrame, type IpcResponse } from '../src/mcp/ipc.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const AGENT = 'bot-a'
const INT = 'int-bot-a'
const CHANNEL = 'C0TEAM'
const BOT_USER = 'U0BOT'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-requester-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } },
      mcpServers: { hub: { transport: 'stdio', command: 'node', args: ['hub.js'], requesterIdentity: true } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      mcpServers: ['hub'],
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: { bindRules: [{ match: { kind: 'mention' } }] },
          config: { botToken: 'xoxb-test', appToken: 'xapp-test' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

/** A runtime whose prompts hang until released, so a turn stays live and can take a steer. It
 *  records the MCP servers each session was opened with, as a real runtime would spawn them. */
function hangingHost() {
  const releases: (() => void)[] = []
  const sessions: unknown[][] = []
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async (...args: unknown[]) => {
      sessions.push(args)
      return `acp-${randomUUID()}`
    }),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return 'end_turn'
    }),
    cancel: vi.fn(async () => releases.shift()?.()),
    stop: vi.fn(async () => {}),
    steeringSupported: vi.fn(() => true),
    steer: vi.fn(async () => 'injected')
  }
  return { host, sessions, releaseAll: () => releases.splice(0).forEach((release) => release()) }
}

function rpc(path: string, token: string): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(encodeFrame({ id: 1, token, op: 'requesterIdentity' })))
    sock.on('data', (chunk: string) => {
      buf += chunk
      const { messages } = decodeFrames<IpcResponse>(buf)
      if (messages.length) {
        sock.end()
        resolve(messages[0]!)
      }
    })
    sock.on('error', reject)
  })
}

/** The endpoint and token the daemon put into the `hub` child of the turn's session. */
function hubBinding(sessions: unknown[][]): { endpoint: string; token: string } {
  for (const args of sessions) {
    const servers = (args[1] ?? []) as { name: string; env?: { name: string; value: string }[] }[]
    const hub = servers.find((s) => s.name === 'hub')
    const env = new Map((hub?.env ?? []).map((e) => [e.name, e.value]))
    const endpoint = env.get('AC_MCP_ENDPOINT')
    const token = env.get('AC_MCP_TOKEN')
    if (endpoint && token) return { endpoint, token }
  }
  throw new Error('no hub server with a requester binding was attached')
}

function slackMessage(user: string, ts: string, thread: string, text: string): NormalizedMessage {
  return {
    msgId: `slack:${CHANNEL}:${ts}`,
    traceId: randomUUID(),
    source: 'user',
    platform: 'slack',
    channel: CHANNEL,
    thread,
    sender: { id: user, isBot: false, name: user },
    text: `<@${BOT_USER}> ${text}`,
    mentionedBots: [BOT_USER],
    isDm: false
  }
}

async function withLiveTurn(run: (ctx: { d: any; rt: ReturnType<typeof hangingHost>; key: string }) => Promise<void>) {
  const root = scaffold()
  const rt = hangingHost()
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory({ userId: BOT_USER, botId: 'B0BOT', teamId: 'T0CHURCH' }),
    root,
    hostFactory: () => rt.host as any
  })
  await daemon.start()
  const d = daemon as any
  try {
    const thread = '1700000000.000100'
    void d.dispatch(AGENT, slackMessage('U0ALICE', thread, thread, 'what are my open Hub tasks?'), INT)
    await vi.waitFor(() => expect(rt.host.prompt).toHaveBeenCalledTimes(1), WAIT)
    const [key] = [...d.activeGateEntries.keys()] as string[]
    await run({ d, rt, key: key! })
  } finally {
    rt.releaseAll()
    await daemon.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

describe('trusted requester over the real control socket (BC fork)', () => {
  it('names the one person behind a live Slack turn', async () => {
    await withLiveTurn(async ({ rt }) => {
      const { endpoint, token } = hubBinding(rt.sessions)
      await expect(rpc(endpoint, token)).resolves.toMatchObject({
        ok: true,
        result: { platform: 'slack', integrationId: INT, userId: 'U0ALICE', channel: CHANNEL }
      })
    })
  })

  it('names nobody once another person’s message is folded into the turn', async () => {
    await withLiveTurn(async ({ d, rt, key }) => {
      const thread = '1700000000.000100'
      void d.dispatch(AGENT, slackMessage('U0BOB', '1700000000.000200', thread, 'and mark mine done'), INT)
      await vi.waitFor(() => expect(d.activeGateEntries.get(key)?.foldedMessages?.length ?? 0).toBe(1), WAIT)
      expect(rt.host.steer).toHaveBeenCalled()
      const { endpoint, token } = hubBinding(rt.sessions)
      await expect(rpc(endpoint, token)).resolves.toMatchObject({ ok: true, result: null })
    })
  })

  it('still names the person when only their own follow-up is folded in', async () => {
    await withLiveTurn(async ({ d, rt, key }) => {
      const thread = '1700000000.000100'
      void d.dispatch(AGENT, slackMessage('U0ALICE', '1700000000.000300', thread, 'only the overdue ones'), INT)
      await vi.waitFor(() => expect(d.activeGateEntries.get(key)?.foldedMessages?.length ?? 0).toBe(1), WAIT)
      const { endpoint, token } = hubBinding(rt.sessions)
      await expect(rpc(endpoint, token)).resolves.toMatchObject({ ok: true, result: { userId: 'U0ALICE' } })
    })
  })
})
