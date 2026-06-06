import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { MastraModelOutput } from '@mastra/core/stream';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';

/**
 * Forward agent text-delta and reasoning-delta chunks to the workflow writer
 * for real-time streaming to the client.
 */
async function pipeStreamToWriter(
  output: MastraModelOutput | undefined,
  writer: import('@mastra/core/tools').ToolStream | undefined,
  runId: string,
) {
  if (!output || !writer) return;
  const reader = output.fullStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === 'text-delta') {
        await writer.write((value as { type: 'text-delta'; payload: { text: string } }).payload.text);
      } else if (value.type === 'reasoning-delta') {
        await writer.custom({
          type: 'reasoning-delta',
          runId,
          from: 'WORKFLOW' as const,
          payload: { text: (value as { type: 'reasoning-delta'; payload: { text: string } }).payload.text },
        });
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────
export const attractionCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(['nature', 'culture', 'food', 'shopping', 'activity', 'other']),
});
export type AttractionCard = z.infer<typeof attractionCardSchema>;

// ─── Shared thinking provider options ──────────────────────────────────────
const THINKING_OPTIONS = {
  providerOptions: {
    anthropic: {
      thinking: { type: 'enabled' as const, budgetTokens: 8000 },
    },
  },
};

// claude-opus-4-7 uses "adaptive" thinking with effort to encourage actual thinking
const THINKING_OPTIONS_OPUS = {
  providerOptions: {
    anthropic: {
      thinking: { type: 'adaptive' as const },
      effort: 'high' as const,
    },
  },
};

// ─── Helper: parse ###JSON:{} from agent response ─────────────────────────
export function parseAgentResponse(text: string): { reply: string; meta: Record<string, unknown> } {
  const markerNewline = text.lastIndexOf('\n###JSON:');
  const markerPos = markerNewline !== -1 ? markerNewline : text.lastIndexOf('###JSON:');
  if (markerPos === -1) return { reply: text.trim(), meta: {} };

  const rawJson = text.slice(markerPos + (markerNewline !== -1 ? 9 : 8)).trim();
  const replyText = text.slice(0, markerPos).trim();

  try {
    return { reply: replyText, meta: JSON.parse(rawJson) };
  } catch {
    try {
      return { reply: replyText, meta: JSON.parse(jsonrepair(rawJson)) };
    } catch {
      // JSON is unrecoverable — still strip the marker so raw JSON never reaches the UI
      return { reply: replyText, meta: {} };
    }
  }
}

// ─── Step 1: Destination Discovery ────────────────────────────────────────
const STEP1_INSTRUCTIONS = `You are a travel planning assistant in PHASE 1: DESTINATION DISCOVERY.

Your goal: have a natural conversation to help the user decide on a travel destination.
Ask clarifying questions about interests, travel style, budget range, duration, etc.

When the user has clearly settled on a SPECIFIC destination (city, region, or country), end your response with:
###JSON:{"confirmed":true,"destination":"<exact destination name>"}

If the destination is still unclear, end your response with:
###JSON:{"confirmed":false}

Always end every response with the ###JSON line. Be warm and helpful.`;

const destinationStep = createStep({
  id: 'destination-discovery',
  inputSchema: z.object({ userMessage: z.string() }),
  outputSchema: z.object({ destination: z.string() }),
  resumeSchema: z.object({ userMessage: z.string() }),
  suspendSchema: z.object({
    reply: z.string(),
    stepName: z.literal('destination'),
    thinking: z.string().optional(),
  }),
  stateSchema: z.object({
    destination: z.string().optional(),
  }),
  execute: async ({ inputData, resumeData, suspend, state, setState, mastra, runId, writer }) => {
    const userMessage = resumeData?.userMessage ?? inputData.userMessage;
    const agent = mastra?.getAgent('travelPlannerAgent');

    const output = await agent?.stream(
      [{ role: 'user' as const, content: userMessage }],
      {
        instructions: STEP1_INSTRUCTIONS,
        memory: { thread: `travel-${runId}`, resource: 'travel-workflow-user' },
        ...THINKING_OPTIONS,
      },
    );

    await pipeStreamToWriter(output, writer, runId ?? '');

    const fullText = (await output?.text) ?? '';
    const reasoningText = (await output?.reasoningText) ?? undefined;
    const { reply, meta } = parseAgentResponse(fullText);

    if (meta.confirmed && typeof meta.destination === 'string') {
      await setState({ ...state, destination: meta.destination });
      return { destination: meta.destination };
    }

    return await suspend({ reply, stepName: 'destination', thinking: reasoningText });
  },
});

// ─── Step 2: Attraction Selection (claude-opus-4-7 + thinking) ─────────────
const STEP2_INSTRUCTIONS = (destination: string) => `You are a travel planning assistant in PHASE 2: ATTRACTION SELECTION.
Destination confirmed: ${destination}

Your goal: suggest 6–8 must-see attractions for this destination.

FIRST call (no prior selections): Generate the initial suggestion list with descriptions, then end with:
###JSON:{"phase":"suggest","cards":[{"id":"1","name":"...","description":"...","category":"nature|culture|food|shopping|activity|other"},{"id":"2",...},...]}

RESUME call (user has responded with selections or text): Review what they selected/said, confirm the final list, then end with:
###JSON:{"phase":"confirmed","selected":["attraction name 1","attraction name 2",...]}

If the user wants different options, provide updated suggestions and end with another ###JSON:{"phase":"suggest","cards":[...]} block.
Always end every response with the ###JSON line.`;

const attractionsStep = createStep({
  id: 'attraction-selection',
  inputSchema: z.object({ destination: z.string() }),
  outputSchema: z.object({ selectedAttractions: z.array(z.string()) }),
  resumeSchema: z.object({
    selectedCards: z.array(z.string()),
    userMessage: z.string().optional(),
  }),
  suspendSchema: z.object({
    reply: z.string(),
    stepName: z.literal('attractions'),
    cards: z.array(attractionCardSchema).optional(),
    thinking: z.string().optional(),
  }),
  stateSchema: z.object({
    destination: z.string().optional(),
    attractions: z.array(attractionCardSchema).optional(),
    selectedAttractions: z.array(z.string()).optional(),
  }),
  execute: async ({ inputData, resumeData, suspend, state, setState, mastra, runId }) => {
    const destination = inputData.destination;

    let userTurn: string;
    if (!resumeData) {
      userTurn = `请为 ${destination} 推荐值得游览的景点。`;
    } else {
      const parts: string[] = [];
      if (resumeData.selectedCards.length > 0) {
        parts.push(`我选择了这些景点：${resumeData.selectedCards.join('、')}`);
      }
      if (resumeData.userMessage?.trim()) {
        parts.push(resumeData.userMessage.trim());
      }
      userTurn = parts.join('\n') || '没有特别偏好，请按您的建议来。';
    }

    // claude-opus-4-7 via attractionPlannerAgent — generate (not stream) to get full JSON
    const agent = mastra?.getAgent('attractionPlannerAgent');
    const result = await agent?.generate(
      [{ role: 'user' as const, content: userTurn }],
      {
        instructions: STEP2_INSTRUCTIONS(destination),
        memory: { thread: `travel-${runId}`, resource: 'travel-workflow-user' },
        ...THINKING_OPTIONS_OPUS,
      },
    );

    const fullText = result?.text ?? '';
    const reasoningText = (await result?.reasoningText) ?? undefined;
    const { reply, meta } = parseAgentResponse(fullText);

    if (meta.phase === 'confirmed' && Array.isArray(meta.selected)) {
      const selected = meta.selected as string[];
      await setState({ ...state, selectedAttractions: selected });
      return { selectedAttractions: selected };
    }

    let cards: AttractionCard[] = [];
    if (Array.isArray(meta.cards)) {
      cards = (meta.cards as unknown[]).filter((c): c is AttractionCard =>
        typeof c === 'object' && c !== null && 'id' in c && 'name' in c,
      );
      await setState({ ...state, attractions: cards });
    }

    return await suspend({ reply, stepName: 'attractions', cards, thinking: reasoningText });
  },
});

// ─── Step 3: Itinerary Planning ────────────────────────────────────────────
const STEP3_INSTRUCTIONS = (destination: string, attractions: string[]) =>
  `You are a travel planning assistant in PHASE 3: ITINERARY PLANNING.
Destination: ${destination}
Selected attractions: ${attractions.join('、')}

Your goal: gather trip preferences then output a full itinerary.

GATHERING phase: Ask for (one or two questions at a time):
1. How many days
2. Who is traveling: solo / couple / family with kids / friends group
3. Preferred pace: relaxed / balanced / packed

When you have all three pieces of info, move to the COMPLETE phase.

During gathering, end with:
###JSON:{"phase":"gathering"}

COMPLETE phase: Generate a detailed day-by-day itinerary in Markdown format.
Include timing, transport tips, meal suggestions, and practical notes.
After the full Markdown itinerary, end with:
###JSON:{"phase":"complete"}

Always end every response with the ###JSON line.`;

const STEP3_CHAT_INSTRUCTIONS = (destination: string) =>
  `You are a helpful travel assistant. The user has completed their ${destination} trip planning.
The full itinerary and conversation history are available in your memory.
Answer questions, suggest adjustments, provide tips, or help with any follow-up requests naturally.
No special JSON format needed — just respond conversationally.`;

const itineraryStep = createStep({
  id: 'itinerary-planning',
  inputSchema: z.object({ selectedAttractions: z.array(z.string()) }),
  outputSchema: z.object({ itinerary: z.string() }),
  resumeSchema: z.object({ userMessage: z.string() }),
  suspendSchema: z.object({
    reply: z.string(),
    stepName: z.literal('itinerary'),
    itinerary: z.string().optional(),
    thinking: z.string().optional(),
  }),
  stateSchema: z.object({
    destination: z.string().optional(),
    selectedAttractions: z.array(z.string()).optional(),
    itineraryGenerated: z.boolean().optional(),
  }),
  execute: async ({ inputData, resumeData, suspend, state, setState, mastra, runId, writer }) => {
    const destination = state.destination ?? 'Unknown';
    const attractions = state.selectedAttractions ?? inputData.selectedAttractions;
    const agent = mastra?.getAgent('travelPlannerAgent');

    // ── Chat mode after itinerary is shown ───────────────────────────────
    if (state.itineraryGenerated) {
      const userTurn = resumeData?.userMessage ?? '';
      const output = await agent?.stream(
        [{ role: 'user' as const, content: userTurn }],
        {
          instructions: STEP3_CHAT_INSTRUCTIONS(destination),
          memory: { thread: `travel-${runId}`, resource: 'travel-workflow-user' },
          ...THINKING_OPTIONS,
        },
      );
      await pipeStreamToWriter(output, writer, runId ?? '');
      const fullText = (await output?.text) ?? '';
      const reasoningText = (await output?.reasoningText) ?? undefined;
      const { reply } = parseAgentResponse(fullText);
      return await suspend({ reply, stepName: 'itinerary', thinking: reasoningText });
    }

    // ── Normal gathering / generation phase ───────────────────────────────
    const userTurn = resumeData?.userMessage
      ?? `好的，我们开始规划 ${destination} 的行程吧！`;

    const output = await agent?.stream(
      [{ role: 'user' as const, content: userTurn }],
      {
        instructions: STEP3_INSTRUCTIONS(destination, attractions),
        memory: { thread: `travel-${runId}`, resource: 'travel-workflow-user' },
        ...THINKING_OPTIONS,
      },
    );

    await pipeStreamToWriter(output, writer, runId ?? '');

    const fullText = (await output?.text) ?? '';
    const reasoningText = (await output?.reasoningText) ?? undefined;
    const { reply, meta } = parseAgentResponse(fullText);

    if (meta.phase === 'complete') {
      await setState({ ...state, itineraryGenerated: true });
      return await suspend({ reply, stepName: 'itinerary', itinerary: reply, thinking: reasoningText });
    }

    return await suspend({ reply, stepName: 'itinerary', thinking: reasoningText });
  },
});

// ─── Workflow ──────────────────────────────────────────────────────────────
export const travelPlannerWorkflow = createWorkflow({
  id: 'travelPlannerWorkflow',
  inputSchema: z.object({ userMessage: z.string() }),
  outputSchema: z.object({ itinerary: z.string() }),
  stateSchema: z.object({
    destination: z.string().optional(),
    attractions: z.array(attractionCardSchema).optional(),
    selectedAttractions: z.array(z.string()).optional(),
  }),
})
  .then(destinationStep)
  .then(attractionsStep)
  .then(itineraryStep)
  .commit();
