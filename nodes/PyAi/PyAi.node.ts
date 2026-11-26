import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleepUnlessExecutionCancelled,
} from 'n8n-workflow';

const apiUrl = 'https://api.pyai.com';
const requestTimeoutMs = 30_000;
const pollIntervalMs = 5_000;

interface TranscriptionJob {
	job_id: string;
	status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
	result?: { text: string } | null;
	result_url?: string | null;
}

interface RecapCall {
	status: 'pending' | 'processing' | 'complete' | 'failed';
	record?: {
		tldr?: string;
		summary?: string;
		next_steps?: string;
		action_items?: IDataObject[];
	} | null;
}

async function request<T>(
	context: IExecuteFunctions,
	options: IHttpRequestOptions,
	itemIndex: number,
	deadline: number,
	allowNotFound = false,
): Promise<T | undefined> {
	const response = await context.helpers.httpRequestWithAuthentication.call(context, 'pyAiApi', {
		...options,
		timeout: Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now())),
		json: true,
		disableFollowRedirect: true,
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
	});
	const { statusCode, body } = response as { statusCode: number; body: T };
	if (allowNotFound && statusCode === 404) return undefined;
	if (statusCode >= 200 && statusCode < 300) return body;

	throw new NodeApiError(context.getNode(), { statusCode } as JsonObject, {
		itemIndex,
		httpCode: String(statusCode),
		message: `PyAI returned HTTP ${statusCode}`,
	});
}

async function poll<T>(
	context: IExecuteFunctions,
	read: () => Promise<T | undefined>,
	deadline: number,
): Promise<T | undefined> {
	const signal = context.getExecutionCancelSignal();
	while (Date.now() < deadline && !signal?.aborted) {
		const result = await read();
		if (result !== undefined) return result;

		const delay = Math.min(pollIntervalMs, deadline - Date.now());
		if (delay > 0) await sleepUnlessExecutionCancelled(context, delay);
	}
	return undefined;
}

export class PyAi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PyAI',
		name: 'pyAi',
		icon: { light: 'file:pyai.svg', dark: 'file:pyai.svg' },
		subtitle: 'Transcribe and summarize',
		group: ['transform'],
		version: 1,
		description: 'Transcribe and summarize a call recording with PyAI',
		defaults: { name: 'PyAI' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'pyAiApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Transcribe and Summarize',
						value: 'transcribeAndSummarize',
						action: 'Transcribe and summarize a call recording',
					},
				],
				default: 'transcribeAndSummarize',
			},
			{
				displayName: 'Recording URL',
				name: 'recordingUrl',
				type: 'string',
				default: '',
				required: true,
				description: 'An HTTPS download URL that PyAI can access without additional headers',
			},
			{
				displayName: 'Call ID',
				name: 'callId',
				type: 'string',
				default: '',
				required: true,
				description:
					'A unique ID for this recording in PyAI. Keep it the same when retrying the same input.',
			},
			{
				displayName: 'Wait Time (Seconds)',
				name: 'timeoutSeconds',
				type: 'number',
				typeOptions: { minValue: 10, maxValue: 1200, numberPrecision: 0 },
				default: 300,
				description: 'How long to wait for transcription and summary together',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const results: INodeExecutionData[] = [];
		const items = this.getInputData();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const rawUrl = this.getNodeParameter('recordingUrl', itemIndex) as string;
				const callId = (this.getNodeParameter('callId', itemIndex) as string).trim();
				const timeoutSeconds = this.getNodeParameter('timeoutSeconds', itemIndex) as number;
				const recordingUrl = URL.parse(rawUrl.trim());
				if (
					!recordingUrl ||
					recordingUrl.protocol !== 'https:' ||
					recordingUrl.username ||
					recordingUrl.password
				) {
					throw new NodeOperationError(
						this.getNode(),
						'Enter an HTTPS recording URL without a username or password',
						{ itemIndex },
					);
				}
				if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(callId)) {
					throw new NodeOperationError(
						this.getNode(),
						'Enter a call ID of up to 128 letters, digits, dots, underscores, or hyphens starting with a letter or digit',
						{ itemIndex },
					);
				}
				if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 1200) {
					throw new NodeOperationError(
						this.getNode(),
						'Wait time must be between 10 and 1200 seconds',
						{ itemIndex },
					);
				}

				const deadline = Date.now() + timeoutSeconds * 1000;
				const job = await request<TranscriptionJob>(
					this,
					{
						method: 'POST',
						url: `${apiUrl}/v1/transcription/jobs`,
						headers: { 'Idempotency-Key': `n8n:${callId}` },
						body: { audio_url: recordingUrl.href, call_id: callId },
					},
					itemIndex,
					deadline,
				);
				if (!job?.job_id) {
					throw new NodeOperationError(
						this.getNode(),
						'PyAI did not return a transcription job ID',
						{ itemIndex },
					);
				}

				const completedJob = await poll(
					this,
					async () => {
						const current = await request<TranscriptionJob>(
							this,
							{
								method: 'GET',
								url: `${apiUrl}/v1/transcription/jobs/${encodeURIComponent(job.job_id)}`,
							},
							itemIndex,
							deadline,
						);
						if (current?.status === 'failed' || current?.status === 'cancelled') {
							throw new NodeOperationError(
								this.getNode(),
								`PyAI transcription ${current.status} (job ${job.job_id})`,
								{ itemIndex },
							);
						}
						return current?.status === 'completed' ? current : undefined;
					},
					deadline,
				);
				if (!completedJob) {
					throw new NodeOperationError(
						this.getNode(),
						`Stopped waiting for PyAI transcription (job ${job.job_id}). Retry with the same call ID and recording URL.`,
						{ itemIndex },
					);
				}

				const recap = await poll(
					this,
					async () => {
						const current = await request<RecapCall>(
							this,
							{
								method: 'GET',
								url: `${apiUrl}/v1/recap/calls/${encodeURIComponent(callId)}`,
							},
							itemIndex,
							deadline,
							true,
						);
						if (current?.status === 'failed') {
							throw new NodeOperationError(this.getNode(), `PyAI Recap failed (call ${callId})`, {
								itemIndex,
							});
						}
						return current?.status === 'complete' ? current : undefined;
					},
					deadline,
				);
				if (!recap) {
					throw new NodeOperationError(
						this.getNode(),
						`Stopped waiting for PyAI Recap (call ${callId}). Check that Recap is enabled for your PyAI project before retrying.`,
						{ itemIndex },
					);
				}

				const summary = recap.record?.summary?.trim() || recap.record?.tldr?.trim();
				if (!summary) {
					throw new NodeOperationError(
						this.getNode(),
						`PyAI Recap returned an empty summary (call ${callId})`,
						{ itemIndex },
					);
				}

				results.push({
					json: {
						callId,
						jobId: job.job_id,
						transcript: completedJob.result?.text ?? null,
						transcriptResultUrl: completedJob.result_url ?? null,
						summary,
						nextSteps: recap.record?.next_steps ?? '',
						actionItems: recap.record?.action_items ?? [],
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(
								this.getNode(),
								'PyAI request could not be completed. Retry with the same call ID and recording URL.',
								{ itemIndex },
							);
				if (!this.continueOnFail()) throw nodeError;
				results.push({ json: { error: nodeError.message }, pairedItem: { item: itemIndex } });
			}
		}

		return [results];
	}
}
