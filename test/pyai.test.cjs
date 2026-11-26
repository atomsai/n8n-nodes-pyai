const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { PyAi } = require('../dist/nodes/PyAi/PyAi.node.js');
const { PyAiApi } = require('../dist/credentials/PyAiApi.credentials.js');

const workflow = JSON.parse(readFileSync('workflows/pyai-call-recap-to-slack.json', 'utf8'));
const recordingUrl = 'https://example.com/call.wav';
const callId = 'synthetic-call-01';
const channelId = 'C1234567';
const parameters = { recordingUrl, callId, timeoutSeconds: 10 };

function execute(responses, overrides = {}) {
	const calls = [];
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'PyAI', type: 'n8n-nodes-pyai.pyAi', typeVersion: 1, parameters: {} }),
		getExecutionCancelSignal: () => undefined,
		getNodeParameter: (name) => ({ ...parameters, ...overrides })[name],
		continueOnFail: () => false,
		helpers: {
			async httpRequestWithAuthentication(credential, request) {
				assert.equal(credential, 'pyAiApi');
				assert.equal(new URL(request.url).origin, 'https://api.pyai.com');
				assert.equal(request.disableFollowRedirect, true);
				calls.push(request);
				assert.ok(responses.length, 'unexpected PyAI request');
				return responses.shift();
			},
		},
	};
	return { calls, result: new PyAi().execute.call(context) };
}

test('the workflow sends a safe summary and next steps to Slack', async () => {
	const { result, calls } = execute([
		{ statusCode: 202, body: { job_id: 'job-1', status: 'queued' } },
		{ statusCode: 200, body: { status: 'completed', result: { text: 'Private transcript' } } },
		{ statusCode: 200, body: { status: 'complete', record: { summary: 'Review pricing & terms. <!channel>', next_steps: 'Send the quote.' } } },
	]);
	const [[item]] = await result;
	assert.equal(calls[0].method, 'POST');
	assert.deepEqual(calls[0].body, { audio_url: recordingUrl, call_id: callId });
	assert.equal(calls[0].headers['Idempotency-Key'], 'n8n:' + callId);
	assert.match(calls[1].url, /\/v1\/transcription\/jobs\/job-1$/);
	assert.match(calls[2].url, /\/v1\/recap\/calls\/synthetic-call-01$/);
	assert.equal(item.json.transcript, 'Private transcript');
	assert.deepEqual(item.pairedItem, { item: 0 });
	const [trigger, settings, pyai, slack] = workflow.nodes;
	for (const [previous, next] of [[trigger, settings], [settings, pyai], [pyai, slack]]) {
		assert.equal(workflow.connections[previous.name].main[0][0].node, next.name);
	}
	assert.equal(pyai.type, 'n8n-nodes-pyai.' + new PyAi().description.name);
	assert.equal(new PyAiApi().name, new PyAi().description.credentials[0].name);
	assert.equal(workflow.active, false);
	assert.ok(workflow.nodes.every((node) => !node.credentials));
	const unwrap = (str) => str.slice(3, -2);
	const linkedSettings = (name) => {
		assert.equal(name, settings.name);
		return { item: { json: { slackChannelId: channelId } } };
	};
	const text = Function('$json', 'return (' + unwrap(slack.parameters.text) + ')')(item.json);
	const channel = Function('$', 'return (' + unwrap(slack.parameters.channelId.value) + ')')(linkedSettings);
	assert.equal(channel, channelId);
	assert.equal(text, '*Call summary*\n\nReview pricing &amp; terms. &lt;!channel&gt;\n\n*Next steps*\nSend the quote.');
	assert.ok(!text.includes(item.json.transcript));
	assert.ok(!text.includes(recordingUrl));
	assert.equal(slack.parameters.otherOptions.unfurl_links, false);
	assert.equal(slack.parameters.otherOptions.includeLinkToWorkflow, false);
});

test('a failed transcription stops before Recap or Slack', async () => {
	const { result, calls } = execute([
		{ statusCode: 202, body: { job_id: 'job-2', status: 'queued' } },
		{ statusCode: 200, body: { status: 'failed' } },
	]);
	await assert.rejects(result, /transcription failed/);
	assert.equal(calls.length, 2);
});

test('a Recap permission failure stops the workflow', async () => {
	const { result, calls } = execute([
		{ statusCode: 202, body: { job_id: 'job-3', status: 'queued' } },
		{ statusCode: 200, body: { status: 'completed', result: { text: 'Synthetic transcript' } } },
		{ statusCode: 403, body: { error: 'insufficient_scope' } },
	]);
	await assert.rejects(result, /HTTP 403/);
	assert.equal(calls.length, 3);
});

test('rejects unsafe or missing inputs before requesting PyAI', async () => {
	for (const overrides of [{ recordingUrl: 'http://example.com/file' }, { callId: '' }]) {
		const { result, calls } = execute([], overrides);
		await assert.rejects(result, /HTTPS recording URL|call ID/);
		assert.equal(calls.length, 0);
	}
});
