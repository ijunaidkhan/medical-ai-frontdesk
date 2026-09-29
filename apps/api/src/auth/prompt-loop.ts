import { BootstrapValidationError } from './bootstrap.js';

/**
 * Asks a question until the answer passes `validate`, telling the person what
 * was wrong each time so they only have to redo that one answer. Gives up after
 * `maxAttempts` (so piped or closed input can never loop forever).
 */
export async function askUntilValid(
  ask: () => Promise<string>,
  validate: (answer: string) => string | null,
  report: (problem: string) => void,
  maxAttempts = 5,
): Promise<string> {
  let lastProblem = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const answer = await ask();
    const problem = validate(answer);
    if (problem === null) {
      return answer;
    }
    lastProblem = problem;
    report(problem);
  }
  throw new BootstrapValidationError(lastProblem);
}
