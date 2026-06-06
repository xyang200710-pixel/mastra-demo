import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { createOpenAI } from '@ai-sdk/openai';
import { storage } from '../storage';

const litellm = createOpenAI({
  apiKey: process.env.MODEL_API_KEY!,
  baseURL: process.env.MODEL_BASE_URL!,
});

// Use .chat() to force Chat Completions API; LiteLLM doesn't support Responses API.
const omModel = litellm.chat('gemini/gemini-3-flash-preview');

export const qaAgent = new Agent({
  id: 'qaAgent',    
  name: 'QA Agent',
  instructions: `You are a helpful QA assistant. Answer questions clearly and concisely.

## Language
Always reply in the same language the user writes in.

## Memory usage
You have two types of persistent memory:

1. **User Profile (Working Memory)** – structured facts about the user that persist across ALL sessions.
   - Update it silently whenever you learn something new: name, location, timezone, language, occupation, interests, or preferences.
   - When a user mentions a location (e.g. "the weather in Yokohama"), store it as their \`location\`.
   - When context is missing, infer from the profile. For example, if the user asks "nearest airport?" and \`location\` is "Yokohama", answer for Yokohama without asking.
   - Only update fields you are confident about. Never hallucinate values.

2. **Observational Memory (OM)** – a background log of what happened in each session.
   - You do not manage this directly; it compresses long conversations automatically.
   - Use it to recall past events within a session and across sessions.

## Behaviour
- Be proactive: use what you know about the user to give personalised answers.
- If profile data would help (e.g. location for a distance question), use it automatically.
- Keep answers focused. Use working memory updates sparingly — only update when you are confident of new stable facts.`,
  model: litellm.chat(process.env.DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4-6'),
  memory: new Memory({
    storage,
    options: {
      // ── Working Memory: User Profile ────────────────────────────────────
      // scope: 'resource' (default) → shared across ALL sessions for the same user.
      // Template is injected into the system prompt as text (no tool-call overhead).
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

      // ── Observational Memory: Long-term event log ────────────────────────
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
