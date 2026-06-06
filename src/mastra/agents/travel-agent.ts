import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { storage } from '../storage';

// Use @ai-sdk/anthropic pointing at LiteLLM so that providerOptions.anthropic.thinking works.
const anthropic = createAnthropic({
  apiKey: process.env.MODEL_API_KEY!,
  baseURL: process.env.MODEL_BASE_URL!,
});

// OM observer uses LiteLLM's OpenAI-compatible endpoint (Gemini model, no thinking needed).
const litellm = createOpenAI({
  apiKey: process.env.MODEL_API_KEY!,
  baseURL: process.env.MODEL_BASE_URL!,
});
const omModel = litellm.chat('gemini/gemini-3-flash-preview');

export const travelPlannerAgent = new Agent({
  id: 'travelPlannerAgent',
  name: 'Travel Planner Agent',
  instructions: `You are a professional travel planning assistant. You guide users through planning trips step by step.

## Language
Reply in the same language the user uses.

## Memory usage
You have two types of persistent memory:

1. **User Profile (Working Memory)** – structured facts about the user that persist across ALL sessions.
   - Update it silently whenever you learn something new: name, location, timezone, language, occupation, interests, or travel preferences.
   - When a user mentions a destination, store it under \`Ongoing context\`.
   - Only update fields you are confident about. Never hallucinate values.

2. **Observational Memory (OM)** – a background log of what happened in each session.
   - You do not manage this directly; it compresses long conversations automatically.`,
  model: anthropic(process.env.DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4-6'),
  memory: new Memory({
    storage,
    options: {
      workingMemory: {
        enabled: true,
        scope: 'resource',
        template: `# User Profile
## Identity
- Name:
- Language:
- Timezone:
- Occupation:

## Location
- Current city/region:
- Country:

## Preferences
- Response style: (concise / detailed / technical)
- Communication style: (formal / casual)

## Interests
(list topics as they emerge)

## Ongoing context
(one-line summary of most recent topic, updated each session)
`,
      },

      observationalMemory: {
        model: omModel,
        activateAfterIdle: 'auto',
        activateOnProviderChange: true,
        temporalMarkers: true,
        observation: {
          messageTokens: 20_000,
          bufferOnIdle: true,
          previousObserverTokens: false,
          threadTitle: true,
        },
        reflection: {
          activateAfterIdle: 'auto',
          activateOnProviderChange: true,
        },
        retrieval: true,
      },
    },
  }),
});
