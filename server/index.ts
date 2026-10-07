import app from './app';
import { PORT } from './config';

app.listen(PORT, '0.0.0.0', () => {
  console.error(`studyos listening on ${PORT}; AI_BASE_URL=${process.env.AI_BASE_URL || '(unset)'}; DEBUG_AI=${process.env.DEBUG_AI || ''}`);
});
