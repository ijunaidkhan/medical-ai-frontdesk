import type { LanguageModel, ModelRequest, ModelResponse } from './language-model.js';

/** One scripted step: a response, or an error to throw. */
export type ScriptedStep = ModelResponse | Error;

/**
 * A fake model for tests: it answers with a fixed script and records what it
 * was sent, so tests can check exactly what reached the model (and that nothing
 * did on a path that must not use it). Never wired up by the application.
 */
export class ScriptedModel implements LanguageModel {
  readonly name = 'scripted';
  readonly configured = true;
  readonly requests: ModelRequest[] = [];
  private position = 0;

  constructor(private readonly steps: ScriptedStep[] | ((request: ModelRequest, index: number) => ScriptedStep)) {}

  complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const step = typeof this.steps === 'function' ? this.steps(request, this.position) : this.steps[this.position];
    this.position += 1;
    if (step === undefined) {
      return Promise.reject(new Error('ScriptedModel ran out of scripted steps'));
    }
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  }
}

/** Shorthands for writing scripts. */
export const say = (text: string): ModelResponse => ({ text, toolCalls: [] });
export const callTool = (name: string, args: Record<string, unknown>, id = `call-${name}`): ModelResponse => ({
  text: '',
  toolCalls: [{ id, name, arguments: args }],
});
