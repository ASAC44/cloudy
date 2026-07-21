import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const file = new URL('../apps/web/public/examples/cloudy-n8n-approval.json', import.meta.url)
const workflow = JSON.parse(await readFile(file, 'utf8'))
const node = (name) => workflow.nodes.find((candidate) => candidate.name === name)

const request = node('Request Cloudy approval')
const wait = node('Wait for Cloudy decision')
const gate = node('Approved?')
const approved = node('Approved exact action')

assert.equal(request.type, 'n8n-nodes-base.httpRequest')
assert.match(request.parameters.url, /^https:\/\/.+\/v1\/automation\/approvals$/)
assert.equal(request.parameters.genericAuthType, 'httpHeaderAuth')
const idempotency = request.parameters.headerParameters.parameters.find(({ name }) => name === 'Idempotency-Key')
assert.match(idempotency.value, /\$execution\.id/)
assert.match(idempotency.value, /cloudy-approval/)
assert.match(request.parameters.jsonBody, /callback_url: \$execution\.resumeUrl/)
assert.match(request.parameters.jsonBody, /expires_in_minutes: 15/)
assert.match(request.parameters.jsonBody, /action: \$json\.action/)

assert.equal(wait.type, 'n8n-nodes-base.wait')
assert.equal(wait.parameters.resume, 'webhook')
assert.equal(wait.parameters.httpMethod, 'POST')
assert.equal(wait.parameters.responseMode, 'onReceived')
assert.equal(wait.parameters.limitWaitTime, true)
assert.ok(wait.parameters.resumeAmount > 15, 'Wait timeout must be longer than the Cloudy approval expiry')

const condition = gate.parameters.conditions.conditions[0]
assert.equal(condition.leftValue, '={{ $json.body.status }}')
assert.equal(condition.rightValue, 'approved')
assert.match(approved.parameters.assignments.assignments[0].value, /Prepare exact action/)

const next = (name, output = 0) => workflow.connections[name]?.main?.[output]?.[0]?.node
assert.equal(next('Prepare exact action'), 'Request Cloudy approval')
assert.equal(next('Request Cloudy approval'), 'Wait for Cloudy decision')
assert.equal(next('Wait for Cloudy decision'), 'Approved?')
assert.equal(next('Approved?', 0), 'Approved exact action')
assert.equal(next('Approved?', 1), 'Stopped safely')

console.log('n8n workflow contract is valid')
