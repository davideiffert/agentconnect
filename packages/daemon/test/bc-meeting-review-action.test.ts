/** BC: the meeting recorder DM's Review and post button enters as the tapping person's own DM. */
import { describe, it, expect } from 'vitest'
import { BC_MEETING_REVIEW_ACTION, SlackConnection } from '../src/slack/connection.js'

type ActionArgs = {
  ack: () => Promise<void>
  action: {
    action_id?: string
    block_id?: string
    value?: string
    selected_option?: { value?: string }
    selected_options?: { value?: string }[]
  }
  body?: {
    trigger_id?: string
    view?: { private_metadata?: string }
    user?: { id?: string }
    channel?: { id?: string }
    state?: { values?: Record<string, Record<string, unknown>> }
  }
}
type Handler = (args: ActionArgs) => Promise<void> | void

/** A Bolt stand-in: enough surface for `start()` to reach handler registration. */
function fakeApp(actions: Map<string, Handler>, chat: Record<string, unknown> = {}) {
  return {
    init: async () => {},
    message: () => {},
    event: () => {},
    action: (id: string | RegExp, handler: Handler) => actions.set(String(id), handler),
    shortcut: () => {},
    command: () => {},
    start: async () => {},
    stop: async () => {},
    client: { auth: { test: async () => ({ user_id: 'UBOT', bot_id: 'BBOT', url: 'https://x.slack.test/' }) }, chat }
  } as never
}

async function connect(
  deps: Record<string, unknown>,
  chat: Record<string, unknown> = {}
): Promise<Map<string, Handler>> {
  const actions = new Map<string, Handler>()
  const conn = new SlackConnection(
    {
      group: { appToken: 'xapp-test', botToken: 'xoxb-test', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 't',
      sendIntervalMs: 0,
      ...deps
    } as never,
    () => fakeApp(actions, chat)
  )
  await conn.start()
  return actions
}

const ack = async () => {}
const REC = '084a5cb6-55d2-480d-8d44-99546f2e79c8'

describe('BC meeting review button', () => {
  it('turns a tap in a DM into a message from the person who tapped', async () => {
    const seen: Array<{ channel: string; isDm: boolean; text: string; sender: { id: string; isBot: boolean } }> = []
    const actions = await connect({ onMessage: (m: never) => seen.push(m) })
    await actions.get(BC_MEETING_REVIEW_ACTION)!({
      ack,
      action: { value: REC },
      body: { user: { id: 'U-DAVID' }, channel: { id: 'D123' } }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ channel: 'D123', isDm: true, sender: { id: 'U-DAVID', isBot: false } })
    expect(seen[0]!.text).toContain(`recording ${REC}`)
  })

  it('ignores a tap outside a DM, a bad value or no user', async () => {
    const seen: unknown[] = []
    const actions = await connect({ onMessage: (m: unknown) => seen.push(m) })
    const fire = actions.get(BC_MEETING_REVIEW_ACTION)!
    await fire({ ack, action: { value: REC }, body: { user: { id: 'U-DAVID' }, channel: { id: 'C123' } } })
    await fire({
      ack,
      action: { value: 'not-a-recording; drop table' },
      body: { user: { id: 'U-DAVID' }, channel: { id: 'D123' } }
    })
    await fire({ ack, action: { value: REC }, body: { channel: { id: 'D123' } } })
    expect(seen).toHaveLength(0)
  })
})
