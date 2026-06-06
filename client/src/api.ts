export const AGENT_ID = 'qaAgent';
export const RESOURCE_ID = 'user-1';

export interface Thread {
  id: string;
  title: string;
  resourceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: { content: string };
  createdAt: string;
}

export async function listThreads(): Promise<Thread[]> {
  const res = await fetch(`/api/memory/threads?agentId=${AGENT_ID}`);
  const data = await res.json();
  return data.threads ?? [];
}

export async function createThread(title = 'New Chat'): Promise<Thread> {
  const res = await fetch(`/api/memory/threads?agentId=${AGENT_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, resourceId: RESOURCE_ID }),
  });
  return res.json();
}

export async function deleteThread(threadId: string): Promise<void> {
  await fetch(`/api/memory/threads/${threadId}?agentId=${AGENT_ID}`, {
    method: 'DELETE',
  });
}

export async function getMessages(threadId: string): Promise<Message[]> {
  const res = await fetch(
    `/api/memory/threads/${threadId}/messages?agentId=${AGENT_ID}`,
  );
  const data = await res.json();
  return data.messages ?? [];
}

export type StreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'text-done' }      // text output complete; tool processing may continue
  | { kind: 'done' }           // full stream closed
  | { kind: 'error'; message: string };

/**
 * Streams an agent response as typed events.
 *
 * - `text`      – incremental text chunk to append
 * - `text-done` – main text is finished; input can be re-enabled
 * - `done`      – stream fully closed (tool calls, memory update done)
 * - `error`     – stream failed
 */
export async function* streamChat(
  threadId: string,
  userMessage: string,
): AsyncGenerator<StreamEvent> {
  let res: Response;
  try {
    res = await fetch(`/api/agents/${AGENT_ID}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: userMessage }],
        memory: { thread: threadId, resource: RESOURCE_ID },
      }),
    });
  } catch (err) {
    yield { kind: 'error', message: String(err) };
    return;
  }

  if (!res.ok) {
    yield { kind: 'error', message: `HTTP ${res.status}` };
    return;
  }

  if (!res.body) {
    yield { kind: 'error', message: 'No response body' };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (!json || json === '[DONE]') continue;

        try {
          const event = JSON.parse(json);
          const type: string = event.type ?? '';

          if (type === 'text-delta' && event.payload?.text) {
            yield { kind: 'text', text: event.payload.text };
          } else if (type === 'text-end') {
            // Text generation complete; tool calls (e.g. updateWorkingMemory) may follow.
            yield { kind: 'text-done' };
          } else if (type === 'error') {
            yield { kind: 'error', message: event.payload?.message ?? 'Unknown error' };
          }
        } catch {
          // ignore malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
    yield { kind: 'done' };
  }
}

// ── Workflow API ─────────────────────────────────────────────────────────────

export const WORKFLOW_ID = 'travelPlannerWorkflow';

export interface AttractionCard {
  id: string;
  name: string;
  description: string;
  category: 'nature' | 'culture' | 'food' | 'shopping' | 'activity' | 'other';
}

export type WorkflowSuspendPayload =
  | { stepName: 'destination'; reply: string; thinking?: string }
  | { stepName: 'attractions'; reply: string; cards?: AttractionCard[]; thinking?: string }
  | { stepName: 'itinerary'; reply: string; itinerary?: string; thinking?: string };

export type WorkflowStreamEvent =
  | { kind: 'suspended'; payload: WorkflowSuspendPayload; stepId: string }
  | { kind: 'text-delta'; text: string }
  | { kind: 'reasoning-delta'; text: string }
  | { kind: 'error'; message: string };

/** Parse a RS-delimited JSON stream from a Mastra workflow endpoint. */
async function* parseWorkflowStream(
  res: Response,
): AsyncGenerator<WorkflowStreamEvent> {
  if (!res.ok) {
    yield { kind: 'error', message: `HTTP ${res.status}` };
    return;
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const RS = '\u001e'; // Record Separator — Mastra's event delimiter

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split(RS);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const json = part.trim();
        if (!json) continue;
        try {
          const event = JSON.parse(json);
          if (event.type === 'workflow-step-suspended') {
            const sp = event.payload?.suspendPayload as WorkflowSuspendPayload;
            yield { kind: 'suspended', payload: sp, stepId: event.payload?.id ?? '' };
          } else if (event.type === 'workflow-step-output') {
            // Text chunks piped via textStream.pipeTo(writer) arrive as workflow-step-output
            const output = event.payload?.output;
            if (typeof output === 'string') {
              yield { kind: 'text-delta', text: output };
            }
          } else if (event.type === 'text-delta') {
            // Direct text-delta (future Mastra versions may emit this)
            yield { kind: 'text-delta', text: event.payload?.text ?? '' };
          } else if (event.type === 'reasoning-delta') {
            yield { kind: 'reasoning-delta', text: event.payload?.text ?? '' };
          }
        } catch {
          // ignore malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Start a new travel workflow run. */
export async function* startTravelWorkflow(
  runId: string,
  userMessage: string,
): AsyncGenerator<WorkflowStreamEvent> {
  const res = await fetch(
    `/api/workflows/${WORKFLOW_ID}/stream?runId=${runId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputData: { userMessage } }),
    },
  );
  yield* parseWorkflowStream(res);
}

/** Resume a suspended travel workflow. */
export async function* resumeTravelWorkflow(
  runId: string,
  stepId: string,
  resumeData: Record<string, unknown>,
): AsyncGenerator<WorkflowStreamEvent> {
  const res = await fetch(
    `/api/workflows/${WORKFLOW_ID}/resume-stream?runId=${runId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: stepId, resumeData }),
    },
  );
  yield* parseWorkflowStream(res);
}

export async function updateThreadTitle(
  threadId: string,
  title: string,
): Promise<void> {
  await fetch(`/api/memory/threads/${threadId}?agentId=${AGENT_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}
