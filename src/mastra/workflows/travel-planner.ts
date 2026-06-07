import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { MastraModelOutput } from '@mastra/core/stream';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';

/**
 * Forward agent text-delta and reasoning-delta chunks to the workflow writer.
 * Text is buffered so that the ###JSON:{...} metadata marker and everything
 * after it is silently dropped — the client only sees the conversational reply.
 */
async function pipeStreamToWriter(
  output: MastraModelOutput | undefined,
  writer: import('@mastra/core/tools').ToolStream | undefined,
  runId: string,
) {
  if (!output || !writer) return;
  const JSON_MARKER = '###JSON:';
  // Hold back the last (MARKER_LEN - 1) chars so a marker split across chunks
  // is always detected before being flushed to the client.
  const HOLD = JSON_MARKER.length - 1;
  let held = '';
  let stopped = false;

  const reader = output.fullStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value.type === 'text-delta') {
        if (stopped) continue; // drain stream but never write after marker
        held += (value as { type: 'text-delta'; payload: { text: string } }).payload.text;

        const markerIdx = held.indexOf(JSON_MARKER);
        if (markerIdx !== -1) {
          const safe = held.slice(0, markerIdx).trimEnd();
          if (safe) await writer.write(safe);
          stopped = true;
        } else {
          // Flush all but the last HOLD chars (guard against split marker)
          const flushUpTo = held.length - HOLD;
          if (flushUpTo > 0) {
            await writer.write(held.slice(0, flushUpTo));
            held = held.slice(flushUpTo);
          }
        }
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
    // Flush any buffered chars that never triggered the marker
    if (!stopped && held) {
      const markerIdx = held.indexOf(JSON_MARKER);
      const end = markerIdx !== -1 ? markerIdx : held.length;
      const safe = held.slice(0, end).trimEnd();
      if (safe) await writer.write(safe);
    }
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

// ─── Step 2a: Attraction Planning (Opus 4.7 — strategic, no overlap) ────────
const attractionBriefSchema = z.object({
  id: z.string(),
  name: z.string(),
  brief: z.string(),
});
type AttractionBrief = z.infer<typeof attractionBriefSchema>;

// attractionPlanOutputSchema is the Zod contract for the Opus planning step.
// Passed as `output` to agent.generate() — model is forced to conform to this
// shape (same principle as Pydantic BaseModel in Python).
const attractionPlanOutputSchema = z.object({
  attractions: z
    .array(
      z.object({
        id: z.string().describe('Sequential identifier starting from "1"'),
        name: z.string().describe('Full attraction name'),
        brief: z.string().describe('1-2 sentences explaining what makes this attraction unique'),
      }),
    )
    .describe('6-8 diverse, non-overlapping attractions'),
});

const STEP2_PLAN_INSTRUCTIONS = (destination: string) =>
  `You are a travel attraction planning specialist.
Destination: ${destination}

Plan a diverse, non-overlapping list of 6-8 must-see attractions.
Requirements:
- Each attraction must offer a DIFFERENT experience (no two should feel the same)
- Mix categories: nature, culture, food, shopping, activity
- Cover different geographic areas of the destination when possible`;

const attractionPlanStep = createStep({
  id: 'attraction-plan',
  inputSchema: z.object({ destination: z.string() }),
  outputSchema: z.object({
    destination: z.string(),
    attractions: z.array(attractionBriefSchema),
  }),
  execute: async ({ inputData, mastra, runId, writer }) => {
    const { destination } = inputData;

    // Let the user know we're working — card generation takes 30-60 s
    await writer?.write(`🗺️ 正在为 **${destination}** 规划景点清单，并发生成推荐卡片，请稍候…`);

    const agent = mastra?.getAgent('attractionPlannerAgent');

    const MAX_RETRIES = 3;
    let attractions: AttractionBrief[] = [];
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await agent?.generate(
          [{ role: 'user' as const, content: `请为 ${destination} 规划 6-8 个多样化、无重叠的景点清单。` }],
          {
            instructions: STEP2_PLAN_INSTRUCTIONS(destination),
            memory: { thread: `travel-${runId}`, resource: 'travel-workflow-user' },
            // Zod schema enforces structured output — equivalent to Pydantic BaseModel
            structuredOutput: { schema: attractionPlanOutputSchema },
            ...THINKING_OPTIONS_OPUS,
          },
        );
        attractions = (result?.object?.attractions ?? []).map((a: AttractionBrief) => ({
          id: a.id,
          name: a.name,
          brief: a.brief,
        }));
        break; // success — exit retry loop
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    if (attractions.length === 0 && lastError) {
      throw lastError; // all retries exhausted — surface the error
    }

    return { destination, attractions };
  },
});

// ─── Step 2b: Card Generation (Sonnet — one card, runs 8 in parallel) ───────
//
// cardContentSchema is the Zod-based "Pydantic" contract we pass to the model.
// Mastra's `output` param enforces this via JSON mode / tool-calling — no
// manual JSON.parse or regex cleanup needed.
const cardContentSchema = z.object({
  name: z.string().describe('Full name of the attraction'),
  description: z
    .string()
    .describe('2-3 sentences: what makes it special, top activities, and one practical tip'),
  category: z
    .enum(['nature', 'culture', 'food', 'shopping', 'activity', 'other'])
    .describe('Attraction type — must be exactly one of the enum values'),
});

const STEP2_CARD_INSTRUCTIONS = `You are a travel card writer.
Given an attraction name, its destination city, and a brief context, write a compelling attraction card.
Focus on what makes it unique and what visitors should do or know.`;

const generateCardStep = createStep({
  id: 'generate-card',
  inputSchema: z.object({
    id: z.string(),
    name: z.string(),
    brief: z.string(),
    destination: z.string(),
  }),
  outputSchema: attractionCardSchema,
  execute: async ({ inputData, mastra, runId }) => {
    const { id, name, brief, destination } = inputData;
    try {
      const agent = mastra?.getAgent('travelPlannerAgent');
      const result = await agent?.generate(
        [{ role: 'user' as const, content: `Attraction: ${name}\nDestination: ${destination}\nContext: ${brief}` }],
        {
          instructions: STEP2_CARD_INSTRUCTIONS,
          memory: { thread: `card-gen-${runId}-${id}`, resource: 'travel-workflow-user' },
          // Zod schema enforces the output structure — equivalent to Pydantic in Python
          structuredOutput: { schema: cardContentSchema },
        },
      );
      const obj = result?.object;
      if (obj) return { id, name: obj.name, description: obj.description, category: obj.category };
    } catch { /* fall through to safe default */ }
    return { id, name, description: brief, category: 'other' as const };
  },
});

// ─── Step 2c: Collect Cards + Suspend/Resume ────────────────────────────────
const collectCardsStep = createStep({
  id: 'attraction-selection', // same ID keeps frontend resume logic unchanged
  inputSchema: z.array(attractionCardSchema),
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
    selectedAttractions: z.array(z.string()).optional(),
    itineraryGenerated: z.boolean().optional(),
  }),
  execute: async ({ inputData, resumeData, suspend, state, setState }) => {
    if (!resumeData) {
      // First execution: all cards are ready — push them to the user
      const cards = inputData as AttractionCard[];
      const reply = `以下是为您精心规划的 ${cards.length} 个景点推荐！请点击卡片选择感兴趣的景点，也可以在输入框中说明偏好或补充想去的地方。`;
      return await suspend({ reply, stepName: 'attractions', cards });
    }

    // Resume: collect selected cards + any free-text supplement
    const selected: string[] = [...resumeData.selectedCards];
    if (resumeData.userMessage?.trim()) {
      selected.push(resumeData.userMessage.trim());
    }
    const finalSelection = selected.length > 0 ? selected : ['（无特别偏好，请按推荐安排）'];

    await setState({ ...state, selectedAttractions: finalSelection });
    return { selectedAttractions: finalSelection };
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
    selectedAttractions: z.array(z.string()).optional(),
    itineraryGenerated: z.boolean().optional(),
  }),
})
  .then(destinationStep)
  .then(attractionPlanStep)
  .map(async ({ inputData }) =>
    inputData.attractions.map((a: AttractionBrief) => ({
      id: a.id,
      name: a.name,
      brief: a.brief,
      destination: inputData.destination,
    })),
  )
  .foreach(generateCardStep, { concurrency: 8 })
  .then(collectCardsStep)
  .then(itineraryStep)
  .commit();
