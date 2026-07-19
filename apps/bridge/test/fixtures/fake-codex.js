import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    process.stdout.write('not json\n')
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'fake' } })}\n`)
  } else if (message.method === 'initialized') {
    process.stdout.write(`${JSON.stringify({ method: 'bridge/ready', params: {} })}\n`)
  } else if (message.method === 'thread/list') {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`)
  }
})
