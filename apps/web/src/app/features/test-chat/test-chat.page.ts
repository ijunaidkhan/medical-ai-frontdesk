import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { CALLER_MESSAGE_MAX_LENGTH, type AgentReply, type ConversationOutcome, type ConversationStatus } from '@frontdesk/shared';
import { firstValueFrom } from 'rxjs';
import { AgentApi } from '../../core/api/agent-api';
import { errorMessages, httpStatusOf } from '../../core/api/api-error';
import { AuthService } from '../../core/auth/auth.service';

interface Line {
  who: 'ai' | 'caller';
  text: string;
  /** A short explanation shown under lines that were not simply written by the AI. */
  note: string | null;
}

/** Said under a line so a reviewer can always tell the AI's own words from a fixed safety message. */
function noteFor(reply: AgentReply): string | null {
  switch (reply.source) {
    case 'scripted_emergency':
      return reply.status === 'handed_off'
        ? 'Fixed safety message, not written by the AI. Staff were alerted and, on a real call, the caller would be handed to a person.'
        : 'Fixed safety message, not written by the AI. Staff were alerted.';
    case 'scripted_urgent':
      return 'Fixed message for an urgent request, not written by the AI. Staff were alerted.';
    case 'scripted_guard':
      return 'The AI’s own reply was not used (it failed a safety check, or the AI model was unavailable), so a fixed safe reply was given instead.';
    case 'scripted_limit':
      return 'This chat reached its length limit.';
    case 'scripted_booking':
      return 'Written by the system from the saved appointment, not by the AI. The AI’s own words for this turn were not used.';
    default:
      return null;
  }
}

const OUTCOME_TEXT: Readonly<Record<ConversationOutcome, string>> = {
  answered: 'The chat ended: the caller’s questions were answered.',
  message_taken: 'The chat ended: a message was left for the team.',
  handed_off: 'The chat ended: it was handed to a person.',
  emergency: 'The chat ended: it involved an emergency, and the emergency message was given.',
  abandoned: 'The chat ended: the caller left.',
};

/**
 * Try the AI receptionist in writing, as a caller would. It is the real
 * receptionist (same rules, same safety checks), not a mock. Anything it does,
 * such as saving a message for staff, really happens in this practice.
 */
@Component({
  selector: 'app-test-chat-page',
  imports: [RouterLink],
  templateUrl: './test-chat.page.html',
  styleUrl: './test-chat.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TestChatPage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(AgentApi);

  protected readonly maxLength = CALLER_MESSAGE_MAX_LENGTH;

  protected readonly conversationId = signal<string | null>(null);
  protected readonly lines = signal<Line[]>([]);
  protected readonly text = signal('');
  protected readonly starting = signal(false);
  protected readonly sending = signal(false);
  /** Why something could not be done; several when the AI is not set up yet. */
  protected readonly problems = signal<string[]>([]);
  /** Whether the problems are about setup (so we can point to the settings page). */
  protected readonly setupProblem = signal(false);
  protected readonly status = signal<ConversationStatus>('active');
  protected readonly outcome = signal<ConversationOutcome | null>(null);
  protected readonly escalated = signal<AgentReply['escalation']>(null);
  protected readonly tasksCreated = signal(0);

  protected readonly ended = computed(() => this.status() !== 'active');
  protected readonly endedText = computed(() => {
    const outcome = this.outcome();
    return outcome ? OUTCOME_TEXT[outcome] : 'The chat ended.';
  });
  protected readonly canSend = computed(() => this.conversationId() !== null && !this.ended() && !this.sending() && this.text().trim() !== '');

  /** Bumped when the practice changes or a new chat starts, so a late answer for an old chat is ignored. */
  private generation = 0;

  constructor() {
    // A chat belongs to one practice: leaving it for another starts over.
    toObservable(this.auth.practiceId)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.reset());
  }

  protected value(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected async start(): Promise<void> {
    if (this.starting()) return;
    this.reset();
    const generation = this.generation;
    this.starting.set(true);
    try {
      const started = await firstValueFrom(this.api.startTestChat());
      if (generation !== this.generation) return;
      this.conversationId.set(started.conversationId);
      this.lines.set([{ who: 'ai', text: started.greeting, note: null }]);
    } catch (error) {
      if (generation !== this.generation) return;
      this.problems.set(errorMessages(error));
      this.setupProblem.set(httpStatusOf(error) === 409);
    } finally {
      if (generation === this.generation) this.starting.set(false);
    }
  }

  protected async send(): Promise<void> {
    const id = this.conversationId();
    const message = this.text().trim();
    if (!id || !this.canSend()) return;
    const generation = this.generation;
    this.problems.set([]);
    this.setupProblem.set(false);
    this.lines.update((lines) => [...lines, { who: 'caller', text: message, note: null }]);
    this.text.set('');
    this.sending.set(true);
    try {
      const reply = await firstValueFrom(this.api.sendMessage(id, message));
      if (generation !== this.generation) return;
      this.lines.update((lines) => [...lines, { who: 'ai', text: reply.reply, note: noteFor(reply) }]);
      this.status.set(reply.status);
      this.outcome.set(reply.outcome);
      this.escalated.set(reply.escalation);
      this.tasksCreated.update((count) => count + reply.createdTaskIds.length);
    } catch (error) {
      if (generation !== this.generation) return;
      // Nothing was answered: take the message back out of the chat and into the box so it can be sent again.
      this.lines.update((lines) => lines.slice(0, -1));
      this.text.set(message);
      this.problems.set(errorMessages(error));
      if (httpStatusOf(error) === 409) {
        this.status.set('completed'); // the server says this chat has ended
        this.outcome.set(null);
      }
    } finally {
      if (generation === this.generation) this.sending.set(false);
    }
  }

  /** Enter sends; Shift+Enter adds a line. */
  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.send();
    }
  }

  private reset(): void {
    this.generation++;
    this.conversationId.set(null);
    this.lines.set([]);
    this.text.set('');
    this.problems.set([]);
    this.setupProblem.set(false);
    this.status.set('active');
    this.outcome.set(null);
    this.escalated.set(null);
    this.tasksCreated.set(0);
    this.starting.set(false);
    this.sending.set(false);
  }
}
