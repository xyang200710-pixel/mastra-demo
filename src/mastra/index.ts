import { Mastra } from '@mastra/core/mastra';
import { storage } from './storage';
import { qaAgent } from './agents/qa-agent';
import { travelPlannerAgent } from './agents/travel-agent';
import { attractionPlannerAgent } from './agents/attraction-agent';
import { travelPlannerWorkflow } from './workflows/travel-planner';

export const mastra = new Mastra({
  agents: { qaAgent, travelPlannerAgent, attractionPlannerAgent },
  workflows: { travelPlannerWorkflow },
  storage,
});
