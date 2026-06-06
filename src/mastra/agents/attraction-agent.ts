import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { createAnthropic } from '@ai-sdk/anthropic';
import { storage } from '../storage';

// Uses LiteLLM's Anthropic-compatible messages endpoint for extended thinking support.
// LiteLLM routes /v1/messages to Anthropic natively.
const anthropicBase = process.env.MODEL_BASE_URL!.replace(/\/v1\/?$/, '');

const anthropic = createAnthropic({
  apiKey: process.env.MODEL_API_KEY!,
  baseURL: `${anthropicBase}/v1`,
});

export const attractionPlannerAgent = new Agent({
  id: 'attractionPlannerAgent',
  name: 'Attraction Planner Agent',
  instructions: `You are a travel attraction specialist. You suggest famous attractions for destinations and help users refine their selection.

## Language
Reply in the same language the user uses.

## Memory usage
You have Working Memory with user profile data. Use it to tailor suggestions based on user preferences.`,
  model: anthropic('claude-opus-4-7'),
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

## Location
- Current city/region:
- Country:

## Preferences
- Travel style:
- Interests:

## Ongoing context
(one-line summary of most recent topic)
`,
      },
    },
  }),
});
