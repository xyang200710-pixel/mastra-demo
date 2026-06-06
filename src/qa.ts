import 'dotenv/config';
import { mastra } from './mastra/index';

const question = process.argv[2] ?? '中国的首都是哪个城市';

const agent = mastra.getAgent('qaAgent');

console.log(`\nQ: ${question}\n`);

const result = await agent.generate([{ role: 'user', content: question }]);

console.log(`A: ${result.text}\n`);
