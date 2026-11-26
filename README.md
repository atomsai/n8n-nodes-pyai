# PyAI for n8n

Transcribe an HTTPS call recording with [PyAI Hear](https://docs.pyai.com/guides/async-transcription-jobs) and summarize it with PyAI Recap. The included [workflow JSON](workflows/pyai-call-recap-to-slack.json) sends the summary and next steps to a Slack channel.

## Install and run

1. In self-hosted n8n 2.x, install `n8n-nodes-pyai` from **Settings → Community nodes** once the package is available on npm. For development, clone this repository, run `npm ci && npm run build && npm pack`, then follow n8n's [manual community-node installation instructions](https://docs.n8n.io/integrations/community-nodes/installation/manual-install/).
2. Import [the workflow JSON](workflows/pyai-call-recap-to-slack.json) with **Import from File**.
3. Set a PyAI API credential on **Transcribe and summarize**. The project must have Recap enabled. Use a key with `hear:transcribe`, `transcribe:jobs`, and `recap:lookup`. Existing keys with `recap:read` retain lookup access. The credential check validates the key and project identity.
4. Set a Slack Access Token credential on **Post summary to Slack**. For a bot token, grant `chat:write` and invite the bot to the destination channel.
5. In **Recording settings**, enter the recording's HTTPS download URL, an unused call ID, and the destination Slack channel ID. A time-limited download link is fine if it remains valid while PyAI fetches the recording.
6. Run the workflow manually. Review the PyAI node's output for the transcript, summary, and action items. Slack receives the summary and next steps.

## Transcribe and Summarize

Use one item per recording. A call ID identifies one recording within the PyAI organization. To resume an uncertain or timed-out submission, keep the call ID and recording URL unchanged. A new recording needs a new call ID. The wait setting applies to both transcription and Recap together. Set a workflow execution timeout that allows the node to finish.

The node returns the transcription job ID and Recap call ID. For results held as a separate artifact, the transcript field can be empty and the signed result URL is returned instead. Use recordings you can process and choose a Slack channel appropriate for the summary. By default, this template disables saved execution data. Rerunning a successful workflow can post the summary again.

## Development

Use Node.js 24 LTS. Run `npm ci`, `npm run lint`, `npm run build`, and `npm test`. Tests use synthetic data and mocked provider requests.
